import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccountInfo,
  CanUseTool,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Result } from "better-result";
import { FileWriteFailed, writeFileAtomic } from "../boundary/fs.ts";
import { fakeClaude } from "../boundary/testing/fake-claude.ts";
import {
  type ClaudeSessionSettings,
  startClaudeSession,
} from "../claude/session.ts";
import { openThreadStore } from "../state/thread-store.ts";
import { createTurnController, type TurnEvent } from "./controller.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-turn-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("turn/start on a Claude thread", () => {
  test("answers with the turn, sends the prompt and completes from Claude's result", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, settings } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    expect(await firstPrompt(claude.prompt())).toBe("hello");
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(sent.slice(0, 3).map((m) => m.method ?? "response")).toEqual([
      "thread/status/changed",
      "turn/started",
      "response",
    ]);
    expect(responseTo(sent, 10)?.result.turn).toMatchObject({
      id: "turn-1",
      status: "inProgress",
    });
    expect(settings[0]).toMatchObject({ cwd: dir, model: MODEL });
    expect(turnCompleted(sent)).toMatchObject({ status: "completed" });
    await until(() => store.get(THREAD)?.runState === "idle");
    expect(store.get(THREAD)).toMatchObject({
      sessionId: "se-1",
      worktree: dir,
      model: MODEL,
    });
  });

  test("keeps one Claude session for the thread across turns", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude]);

    await completeTurn(turns, sent, claude, 10);
    await completeTurn(turns, sent, claude, 11);

    expect(settings).toHaveLength(1);
    expect(turnsCompleted(sent)).toEqual(["completed", "completed"]);
  });

  test("accepts the next turn as soon as the previous one completes", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);
    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
  });

  test("shows a tool that needed approval as declined", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "clean up"), undefined);
    await until(() => claude.started());
    const canUseTool = claude.options().canUseTool as CanUseTool;
    const decision = await canUseTool(
      "Bash",
      { command: "rm -rf build" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-1",
        requestId: "request-1",
      },
    );
    claude.emit(sdk(bashCall("tool-1")));
    claude.emit(sdk(toolError("tool-1")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(decision?.behavior).toBe("deny");
    const command = completedItems(sent).find(
      (item) => item.type === "commandExecution",
    );
    expect(command).toMatchObject({ status: "declined" });
  });

  test("fails the turn when the login is not a subscription", async () => {
    const claude = fakeClaude({ apiProvider: "bedrock" });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => turnCompleted(sent) !== undefined);

    expect(responseTo(sent, 10)?.result).toBeDefined();
    expect(turnCompleted(sent)).toMatchObject({ status: "failed" });
  });

  test("resumes the stored session after the stream fails", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.started());
    first.emit(sdk(answer("msg-1", "partial")));
    first.fail(new Error("socket closed"));
    await until(() => turnCompleted(sent) !== undefined);
    await completeTurn(turns, sent, second, 11);

    expect(turnsCompleted(sent)).toEqual(["failed", "completed"]);
    expect(first.closes()).toBe(1);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
  });
});

describe("session ids", () => {
  test("resumes from the session id Claude reported even when saving it failed", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let writes = 0;
    const { turns, sent, settings, events } = await harness([first, second], {
      files: {
        writeState: async (target, content) =>
          ++writes === 1 ? writeFileAtomic(target, content) : diskFull(target),
      },
    });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.started());
    first.emit(sdk(answer("msg-1", "partial")));
    first.fail(new Error("socket closed"));
    await until(() => turnCompleted(sent) !== undefined);
    await completeTurn(turns, sent, second, 11);

    expect(events).toContainEqual({
      event: "claude_turn",
      step: "session_not_saved",
      detail: "StatePersistFailed",
    });
    expect(settings[1]).toMatchObject({ resume: "se-1" });
  });
});

describe("turn/interrupt", () => {
  test("replies before the turn completes as interrupted", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => claude.interrupts() === 1);
    claude.emit(
      sdk(result({ subtype: "error_during_execution", is_error: true })),
    );
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
    const reply = sent.findIndex((m) => m.id === 20);
    const completed = sent.findIndex((m) => m.method === "turn/completed");
    expect(sent[reply]).toEqual({ id: 20, result: {} });
    expect(reply).toBeLessThan(completed);
    expect(claude.closes()).toBe(0);
  });

  test.each([
    ["a send still queued", ["uuid-queued"]],
    ["no receipt from an older CLI", undefined],
  ])("closes Claude when the interrupt leaves %s", async (_label, stillQueued) => {
    const claude = fakeClaude(
      SUBSCRIPTION,
      stillQueued === undefined ? {} : { stillQueued },
    );
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
    expect(claude.closes()).toBe(1);
  });

  test("keeps an interrupt accepted while Claude was starting", async () => {
    const claude = fakeClaude({ apiProvider: "bedrock" });
    let start = () => {};
    const beforeStart = new Promise<void>((resolve) => {
      start = resolve;
    });
    const { turns, sent } = await harness([claude], { beforeStart });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    turns.interruptTurn(interrupt(20, "turn-1"));
    start();
    await until(() => turnCompleted(sent) !== undefined);

    expect(responseTo(sent, 20)).toEqual({ id: 20, result: {} });
    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
  });

  test("closes Claude when the interrupt fails", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      interruptError: new Error("no control channel"),
    });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
    expect(claude.closes()).toBe(1);
  });

  test("refuses a turn that already completed", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);
    turns.interruptTurn(interrupt(20, "turn-1"));

    expect(responseTo(sent, 20)?.error).toBeDefined();
    expect(claude.interrupts()).toBe(0);
  });

  test("refuses a turn id that is not running", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.interruptTurn(interrupt(20, "turn-9"));

    expect(responseTo(sent, 20)?.error).toBeDefined();
    expect(claude.interrupts()).toBe(0);
  });
});

describe("refused requests", () => {
  test.each([
    ["non-text input", { input: [{ type: "image", url: "x" }] }],
    ["a Codex model", { model: "gpt-fixture" }],
    ["another Claude model", { model: "claude-opus-5-5" }],
    [
      "another Claude model in the collaboration mode",
      {
        model: MODEL,
        collaborationMode: {
          mode: "default",
          settings: { model: "claude-opus-5-5" },
        },
      },
    ],
    [
      "plan mode",
      { collaborationMode: { mode: "plan", settings: { model: MODEL } } },
    ],
    ["another working directory", { cwd: "/elsewhere" }],
  ])("refuses %s without starting Claude", async (_name, override) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    const request = turnStart(10, "hello");
    turns.startTurn(
      { ...request, params: { ...request.params, ...override } },
      undefined,
    );

    expect(responseTo(sent, 10)?.error.code).toBe(-32600);
    expect(claude.started()).toBe(false);
  });

  test("refuses a second turn while one is running", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    turns.startTurn(turnStart(11, "again"), undefined);

    expect(responseTo(sent, 11)?.error).toBeDefined();
  });

  test("answers a refused request with an error", async () => {
    const { turns, sent } = await harness([]);

    turns.refuse({ id: 12, params: { threadId: THREAD } }, "not yet");

    expect(responseTo(sent, 12)?.error).toBeDefined();
  });

  test("switches a Codex thread to Claude only when its directory is known", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude], {
      adopt: false,
    });
    const request = turnStart(10, "hello");
    const withModel = {
      ...request,
      params: { ...request.params, model: MODEL },
    };

    turns.startTurn(withModel, undefined);
    turns.startTurn({ ...withModel, id: 11 }, dir);
    await until(() => claude.started());

    expect(responseTo(sent, 10)?.error).toBeDefined();
    expect(settings[0]).toMatchObject({ cwd: dir, model: MODEL });
  });
});

describe("closeAll", () => {
  test("stops Claude, ends the running turn and refuses new ones", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.closeAll();
    await until(() => turnCompleted(sent) !== undefined);
    turns.startTurn(turnStart(11, "again"), undefined);

    expect(claude.closes()).toBe(1);
    expect(turnCompleted(sent)).toMatchObject({ status: "failed" });
    expect(responseTo(sent, 11)?.error).toBeDefined();
  });
});

const diskFull = async (target: string) =>
  Result.err(
    new FileWriteFailed({
      path: target,
      cause: new Error("disk full"),
      message: `cannot write ${target}`,
    }),
  );

const THREAD = "th-fixture-1";
const MODEL = "claude-sonnet-5";
const SUBSCRIPTION: AccountInfo = {
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};

// biome-ignore lint/suspicious/noExplicitAny: messages are checked by shape in each test.
type Sent = any;

const harness = async (
  fakes: ReturnType<typeof fakeClaude>[],
  {
    adopt = true,
    files = {},
    beforeStart = Promise.resolve(),
  }: {
    adopt?: boolean;
    files?: Parameters<typeof openThreadStore>[1];
    beforeStart?: Promise<void>;
  } = {},
) => {
  const opened = await openThreadStore(join(dir, "threads.json"), files);
  if (opened.isErr()) return expect.unreachable(opened.error.message);
  const store = opened.value;
  const sent: Sent[] = [];
  const events: TurnEvent[] = [];
  const settings: ClaudeSessionSettings[] = [];
  let turnCount = 0;
  const turns = createTurnController({
    store,
    send: (message) => sent.push(message),
    log: (event) => events.push(event),
    startSession: async (session) => {
      const fake = fakes[settings.length];
      settings.push(session);
      if (fake === undefined) return expect.unreachable("no fake Claude left");
      await beforeStart;
      return startClaudeSession(session, fake.runtime);
    },
    now: () => 1_700_000_000_000,
    newTurnId: () => `turn-${++turnCount}`,
  });
  if (adopt) turns.adopt(THREAD, { model: MODEL, cwd: dir });
  return { turns, sent, events, store, settings };
};

const completeTurn = async (
  turns: ReturnType<typeof createTurnController>,
  sent: Sent[],
  claude: ReturnType<typeof fakeClaude>,
  id: number,
) => {
  const before = turnsCompleted(sent).length;
  turns.startTurn(turnStart(id, `prompt ${id}`), undefined);
  await until(() => responseTo(sent, id) !== undefined);
  claude.emit(sdk(answer(`msg-${id}`, "ok")));
  claude.emit(sdk(success()));
  await until(() => turnsCompleted(sent).length > before);
};

const turnStart = (id: number, text: string) => ({
  id,
  params: {
    threadId: THREAD,
    input: [{ type: "text", text, text_elements: [] }],
  } as Record<string, unknown>,
});

const interrupt = (id: number, turnId: string) => ({
  id,
  params: { threadId: THREAD, turnId },
});

const until = async (condition: () => boolean) => {
  for (let waited = 0; !condition(); waited += 2) {
    if (waited > 2000) return expect.unreachable("condition never held");
    await Bun.sleep(2);
  }
};

const firstPrompt = async (prompt: AsyncIterable<SDKUserMessage> | null) => {
  if (prompt === null) return null;
  const next = await prompt[Symbol.asyncIterator]().next();
  return next.done === true ? null : next.value.message.content;
};

const responseTo = (sent: Sent[], id: number) =>
  sent.find((message) => message.id === id);

const turnCompleted = (sent: Sent[]) =>
  sent.find((message) => message.method === "turn/completed")?.params.turn;

const turnsCompleted = (sent: Sent[]) =>
  sent
    .filter((message) => message.method === "turn/completed")
    .map((message) => message.params.turn.status);

const completedItems = (sent: Sent[]) =>
  sent
    .filter((message) => message.method === "item/completed")
    .map((message) => message.params.item);

const sdk = (message: object) =>
  ({
    session_id: "se-1",
    uuid: "uuid-fixture",
    ...message,
  }) as unknown as SDKMessage;

const answer = (id: string, text: string) => ({
  type: "assistant",
  message: { id, content: [{ type: "text", text }], stop_reason: "end_turn" },
  parent_tool_use_id: null,
});

const bashCall = (toolUseId: string) => ({
  type: "assistant",
  message: {
    id: "msg-tool",
    content: [
      {
        type: "tool_use",
        id: toolUseId,
        name: "Bash",
        input: { command: "rm -rf build" },
      },
    ],
    stop_reason: "tool_use",
  },
  parent_tool_use_id: null,
});

const toolError = (toolUseId: string) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "denied",
        is_error: true,
      },
    ],
  },
  parent_tool_use_id: null,
});

const success = () =>
  result({ subtype: "success", is_error: false, result: "done" });

const result = (fields: object) => ({
  type: "result",
  errors: [],
  permission_denials: [],
  ...fields,
});
