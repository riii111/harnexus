import { afterEach, beforeEach, expect } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountInfo,
  type CanUseTool,
  createSdkMcpServer,
  type PermissionUpdate,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Result } from "better-result";
import type { ResizeImage } from "../../infra/claude/images.ts";
import {
  createModelCatalog,
  type EffortRule,
  effortRule,
} from "../../infra/claude/models.ts";
import {
  type ClaudeSessionSettings,
  claudeSessionExists,
  startClaudeSession,
} from "../../infra/claude/session.ts";
import { fakeClaude } from "../../infra/claude/testing/fake-claude.ts";
import {
  listClaudeConversations,
  readLastRecordUuid,
} from "../../infra/claude/transcripts.ts";
import { createCodexLink } from "../../infra/codex/codex-link.ts";
import { createDelegationWatch } from "../../infra/codex/delegations.ts";
import type { ServerRequest } from "../../infra/codex/server-requests.ts";
import { openThreadStore } from "../../infra/thread-store.ts";
import { FileWriteFailed } from "../../runtime/fs.boundary.ts";

import { type ClaudeLogEvent, createClaudeRuntime } from "../claude/runtime.ts";
import { createTurnController } from "../controller.ts";
import { createSubagents } from "../subagents.ts";
import { createThreadValues } from "../thread-values.ts";
import type { TurnLink } from "../turn-runtime.ts";

type StartSession = Parameters<typeof createClaudeRuntime>[0]["startSession"];

type StartSessionOverride = (
  settings: ClaudeSessionSettings,
  signal: AbortSignal,
  fake: ReturnType<typeof fakeClaude>,
) => ReturnType<StartSession>;

export let dir: string;

export const useTempDir = () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harnexus-turn-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
};

export const askTool = (
  claude: ReturnType<typeof fakeClaude>,
  toolName: string,
  input: Record<string, unknown>,
  options: {
    toolUseID?: string;
    agentID?: string;
    signal?: AbortSignal;
    decisionReason?: string;
    defaultToNo?: boolean;
    suggestions?: PermissionUpdate[];
    suppressAlwaysAllowRule?: boolean;
  } = {},
) => {
  const canUseTool = claude.options().canUseTool as CanUseTool;
  return canUseTool(toolName, input, {
    signal: options.signal ?? new AbortController().signal,
    toolUseID: options.toolUseID ?? "tool-1",
    requestId: "request-1",
    ...(options.decisionReason === undefined
      ? {}
      : { decisionReason: options.decisionReason }),
    ...(options.agentID === undefined ? {} : { agentID: options.agentID }),
    ...(options.defaultToNo === undefined
      ? {}
      : { defaultToNo: options.defaultToNo }),
    ...(options.suggestions === undefined
      ? {}
      : { suggestions: options.suggestions }),
    ...(options.suppressAlwaysAllowRule === undefined
      ? {}
      : { suppressAlwaysAllowRule: options.suppressAlwaysAllowRule }),
  });
};

export const appRequest = async (sent: Sent[]) => {
  const find = () =>
    sent.find((m) => typeof m.id === "string" && m.id.startsWith("harnexus-"));
  await until(() => find() !== undefined);
  return find();
};

export const resolvedRequests = (sent: Sent[]) =>
  sent
    .filter((m) => m.method === "serverRequest/resolved")
    .map((m) => m.params.requestId);

export const diskFull = async (target: string) =>
  Result.err(
    new FileWriteFailed({
      path: target,
      cause: new Error("disk full"),
      message: `cannot write ${target}`,
    }),
  );

// The harness hands out fakes in the order Claude starts, so OTHER_THREAD waits until THREAD has taken the first.
export const twoWorkers = async (fakes: ReturnType<typeof fakeClaude>[]) => {
  const started = await harness(fakes);
  started.turns.adopt(OTHER_THREAD, { model: MODEL, cwd: OTHER_DIR });
  started.turns.startTurn(turnStart(10, "hello"), undefined);
  await until(() => fakes[0]?.started() === true);
  started.turns.startTurn(turnStart(11, "hello", OTHER_THREAD), undefined);
  return started;
};

export const reply = (
  id: number,
  threadId: string,
  source: string,
  tool = "send_message_to_thread",
) => ({
  id,
  params: {
    threadId,
    input: [],
    toolOutput: {
      name: tool,
      namespace: "codex_app",
      output: delegation(source),
    },
  } as Record<string, unknown>,
});

export const delegation = (source: string) =>
  `<codex_delegation>\n  <source_thread_id>${source}</source_thread_id>\n  <input>review done</input>\n</codex_delegation>`;

export const startedTurns = (sent: Sent[]) =>
  sent
    .filter((message) => message.method === "turn/started")
    .map((message) => message.params.turn.id);

export const createGate = () => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

export const THREAD = "th-fixture-1";

export const OTHER_THREAD = "th-fixture-2";

export const OTHER_DIR = "/work/other-worktree";

export const MODEL = "claude-sonnet-5";

export const OTHER_MODEL = "claude-opus-5-5";

export const BUILT_IN_EFFORTS = createModelCatalog().effortsOf;

export const defaultRule = effortRule({}, BUILT_IN_EFFORTS);

export const SUBSCRIPTION: AccountInfo = {
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};

// biome-ignore lint/suspicious/noExplicitAny: messages are checked by shape in each test.
export type Sent = any;

export const harness = async (
  fakes: ReturnType<typeof fakeClaude>[],
  {
    adopt = true,
    files = {},
    beforeStart = Promise.resolve(),
    onSend = () => {},
    unsettledWrite = () => false,
    idleSessionMs,
    permissionMode,
    missingSessions = [],
    sessionLookupFails = false,
    lookupSession,
    lastRecord,
    startSession: startSessionOverride,
    materializeFailures = 0,
    renameFails = false,
    linkRequest,
    readHistory,
    effortRule = defaultRule,
    ownTurnsShown = true,
    resizeImage = async () => Result.err({ _tag: "ImageResizeFailed" }),
    now = () => 1_700_000_000_000,
  }: {
    adopt?: boolean;
    files?: Parameters<typeof openThreadStore>[1];
    beforeStart?: Promise<void>;
    onSend?: (message: Sent) => void;
    unsettledWrite?: () => boolean;
    idleSessionMs?: number;
    permissionMode?: "default" | "auto";
    missingSessions?: string[];
    sessionLookupFails?: boolean;
    lookupSession?: Parameters<typeof createClaudeRuntime>[0]["findSession"];
    lastRecord?: Parameters<typeof createClaudeRuntime>[0]["lastRecordOf"];
    startSession?: StartSessionOverride;
    materializeFailures?: number;
    renameFails?: boolean;
    linkRequest?: ServerRequest;
    readHistory?: Parameters<typeof createClaudeRuntime>[0]["readHistory"];
    effortRule?: EffortRule;
    ownTurnsShown?: boolean;
    resizeImage?: ResizeImage;
    now?: () => number;
  } = {},
) => {
  const opened = await openThreadStore(join(dir, "threads.json"), files);
  if (opened.isErr()) return expect.unreachable(opened.error.message);
  const store = opened.value;
  const sent: Sent[] = [];
  const events: ClaudeLogEvent[] = [];
  const settings: ClaudeSessionSettings[] = [];
  const links: string[] = [];
  const gates: string[] = [];
  const materialized: string[] = [];
  const renames: { threadId: string; name: string }[] = [];
  const toolCalls: unknown[] = [];
  const sessionLinks: TurnLink[] = [];
  let failuresLeft = materializeFailures;
  let turnCount = 0;
  const send = (message: Sent) => {
    sent.push(message);
    onSend(message);
  };
  const log = (event: ClaudeLogEvent) => events.push(event);
  const threads = createThreadValues(store, log);
  const subagents = createSubagents({ send, now });
  const runtime = createClaudeRuntime({
    threads,
    findSession:
      lookupSession ??
      (async (sessionId) =>
        sessionLookupFails
          ? claudeSessionExists(sessionId, await unlistableConfigDir())
          : Result.ok(!missingSessions.includes(sessionId))),
    listConversations: (cwd, since) =>
      listClaudeConversations(cwd, { since, configDir: claudeDir() }),
    lastRecordOf:
      lastRecord ?? ((sessionId) => readLastRecordUuid(sessionId, claudeDir())),
    openLink: (threadId) => {
      links.push(threadId);
      const link =
        linkRequest === undefined
          ? {
              server: createSdkMcpServer({ name: "codex_link", tools: [] }),
              allowedTools: ALLOWED_TOOLS,
              hasUnsettledWrite: unsettledWrite,
              stopWrites: () => gates.push("stop"),
              acceptWrites: () => gates.push("accept"),
            }
          : createCodexLink({
              callerThreadId: threadId,
              store,
              request: (method, params, options) => {
                toolCalls.push(params);
                return linkRequest(method, params, options);
              },
              delegations: createDelegationWatch(store.claimReviewer),
            });
      sessionLinks.push(link);
      return link;
    },
    renameThread: async (threadId, name) => {
      renames.push({ threadId, name });
      return renameFails
        ? Result.err({ _tag: "ServerRequestRejected" as const })
        : Result.ok({});
    },
    send,
    log,
    ...(readHistory !== undefined && { readHistory }),
    startSession: async (session, signal) => {
      const fake = fakes[settings.length];
      settings.push(session);
      if (fake === undefined) return expect.unreachable("no fake Claude left");
      if (startSessionOverride !== undefined) {
        return startSessionOverride(session, signal, fake);
      }
      await beforeStart;
      return startClaudeSession(session, fake.runtime, signal);
    },
    now,
    effortRule,
    subagents,
    resizeImage,
    ...(idleSessionMs !== undefined && { idleSessionMs }),
    ...(permissionMode !== undefined && { permissionMode }),
  });
  const runs = new Map<string, Promise<void>>();
  const turns = createTurnController({
    store,
    threads,
    runtime: {
      ...(ownTurnsShown
        ? runtime
        : { ...runtime, listen: () => runtime.listen(() => false) }),
      run: (turn) => {
        const ran = runtime.run(turn);
        runs.set(turn.turnId, ran);
        return ran;
      },
    },
    materializeThread: async (threadId) => {
      materialized.push(threadId);
      if (failuresLeft === 0) return Result.ok({});
      failuresLeft -= 1;
      return Result.err({ _tag: "ServerRequestUnanswered" as const });
    },
    send,
    log,
    now,
    newTurnId: () => `turn-${++turnCount}`,
    effortRule,
  });
  if (adopt) turns.adopt(THREAD, { model: MODEL, cwd: dir });
  turnRuns.set(turns, runs);
  return {
    turns,
    sent,
    events,
    store,
    settings,
    links,
    gates,
    materialized,
    renames,
    toolCalls,
    subagents,
    runtime,
    sessionLinks,
  };
};

export const restartedWithUnknownOutcome = async (
  fakes: ReturnType<typeof fakeClaude>[],
  options: Parameters<typeof harness>[1] = {},
) => {
  const first = fakeClaude(SUBSCRIPTION);
  const before = await harness([first], { unsettledWrite: () => true });
  await completeTurn(before.turns, before.sent, first, 10);
  await until(() => before.store.get(THREAD)?.runState === "outcomeUnknown");
  return harness(fakes, options);
};

export const completeTurn = async (
  turns: ReturnType<typeof createTurnController>,
  sent: Sent[],
  claude: ReturnType<typeof fakeClaude>,
  id: number,
  messageId?: string,
  effort?: string,
) => {
  const before = completedTurnStatuses(sent).length;
  const typed = turnStart(id, `prompt ${id}`);
  const request = effort === undefined ? typed : withEffort(typed, effort);
  turns.startTurn(
    messageId === undefined ? request : withMessageId(request, messageId),
    undefined,
  );
  await until(() => responseTo(sent, id) !== undefined);
  claude.emit(sdk(answer(`msg-${id}`, "ok")));
  claude.emit(sdk(success()));
  await until(() => completedTurnStatuses(sent).length > before);
  // The turn reads Claude's record after turn/completed, so a record the test writes next would otherwise be taken as the turn's own.
  const run = turnRuns.get(turns)?.get(responseTo(sent, id).result.turn.id);
  if (run === undefined) return expect.unreachable("turn never ran");
  await run;
};

const turnRuns = new WeakMap<
  ReturnType<typeof createTurnController>,
  Map<string, Promise<void>>
>();

export const turnStart = (id: number, text: string, threadId = THREAD) => ({
  id,
  params: {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
  } as Record<string, unknown>,
});

export const withMessageId = (
  request: ReturnType<typeof turnStart>,
  clientUserMessageId: string,
) => ({ ...request, params: { ...request.params, clientUserMessageId } });

export const withEffort = (
  request: ReturnType<typeof turnStart>,
  effort: string,
) => ({
  ...request,
  params: { ...request.params, effort },
});

export const interrupt = (id: number, turnId: string) => ({
  id,
  params: { threadId: THREAD, turnId },
});

// Long enough for a turn that was wrongly accepted to reach Claude.
export const settle = () => Bun.sleep(20);

export const ALLOWED_TOOLS = ["mcp__codex_link__read_thread"];

export const OUTCOME_UNKNOWN =
  "the previous Claude turn on this thread stopped before its outcome was known; check what that turn did, such as changed files or messages to other threads, then send a message yourself to continue";

// Claude's records for the harness live under the test directory, so a test writes the conversations it lists.
export const claudeDir = () => join(dir, "claude-records");

// A link to itself cannot be listed, as an unreadable folder cannot, and still leaves the test directory removable.
export const unlistableConfigDir = async () => {
  const configDir = join(dir, "claude-config");
  const project = join(configDir, "projects", "-work-tree");
  await mkdir(join(configDir, "projects"), { recursive: true });
  await symlink(project, project);
  return configDir;
};

export const REFUSED = (id: number) => ({
  id,
  error: { code: -32600, message: expect.any(String) },
});

// The test's own timeout ends a wait that never holds; this only stops one left running after it.
export const until = async (condition: () => boolean) => {
  const deadline = performance.now() + UNTIL_BACKSTOP_MS;
  while (!condition()) {
    if (performance.now() > deadline) {
      return expect.unreachable("condition never held");
    }
    await Bun.sleep(2);
  }
};

const UNTIL_BACKSTOP_MS = 30_000;

export const firstPrompt = async (
  prompt: AsyncIterable<SDKUserMessage> | null,
) => {
  if (prompt === null) return null;
  const next = await prompt[Symbol.asyncIterator]().next();
  return next.done === true ? null : next.value.message.content;
};

export const promptsUntil = async (
  claude: ReturnType<typeof fakeClaude>,
  count: number,
) => {
  const prompt = claude.prompt();
  if (prompt === null) return [];
  const iterator = prompt[Symbol.asyncIterator]();
  const texts: unknown[] = [];
  while (texts.length < count) {
    const next = await iterator.next();
    if (next.done === true) break;
    texts.push(next.value.message.content);
  }
  return texts;
};

export const responseTo = (sent: Sent[], id: number) =>
  sent.find((message) => message.id === id);

export const completedTurns = (sent: Sent[]) =>
  sent
    .filter((message) => message.method === "turn/completed")
    .map((message) => message.params.turn);

export const completedTurnStatuses = (sent: Sent[]) =>
  completedTurns(sent).map((turn) => turn.status);

export const turnCompleted = (sent: Sent[]) =>
  sent.find((message) => message.method === "turn/completed")?.params.turn;

export const completedItems = (sent: Sent[]) =>
  sent
    .filter((message) => message.method === "item/completed")
    .map((message) => message.params.item);

export const sdk = (message: object) =>
  ({
    session_id: "se-1",
    uuid: "uuid-fixture",
    ...message,
  }) as unknown as SDKMessage;

export const answer = (id: string, text: string) => ({
  type: "assistant",
  message: { id, content: [{ type: "text", text }], stop_reason: "end_turn" },
  parent_tool_use_id: null,
});

// The CLI names the sends a turn took and counts those still queued; leaving them out stands for an older CLI.
export const success = (taken?: (string | undefined)[], queued?: number) =>
  result({
    subtype: "success",
    is_error: false,
    result: "done",
    ...(taken !== undefined && { user_message_uuids: taken }),
    ...(queued !== undefined && { queued_turn_count: queued }),
  });

// Every result carries its turn's usage, as the SDK's does.
export const result = (fields: object) => ({
  type: "result",
  errors: [],
  permission_denials: [],
  usage: TURN_USAGE,
  modelUsage: { [MODEL]: { contextWindow: 200_000 } },
  ...fields,
});

export const TURN_USAGE = {
  input_tokens: 4,
  cache_read_input_tokens: 20,
  cache_creation_input_tokens: 10,
  output_tokens: 6,
};
