import type { InferErr } from "better-result";
import {
  type EffortRule,
  isClaudeModel,
  type ModelCatalog,
} from "../infra/claude/models.ts";
import type { readClaudeSubagents } from "../infra/claude/session.ts";
import {
  type DelegationWatch,
  delegationSource,
} from "../infra/codex/delegations.ts";
import type { LiveTurn } from "../presentation/history.ts";
import { isObject } from "../runtime/object.ts";
import {
  type createHistoryRequests,
  HISTORY_METHODS,
  type HistoryEvent,
  isHistoryMethod,
} from "./history-request.ts";
import { encode, encodeWithoutParams, parseMessage } from "./json-line.ts";
import {
  type CompatibilityLogEvent,
  createCompatibility,
} from "./route-compatibility.ts";
import {
  createServerResponses,
  openingThread,
  type Pending,
  type ResponseEvent,
} from "./route-response.ts";
import type { createSideChats, Opened } from "./side-chat.ts";
import type { SubagentRequests } from "./subagent-requests.ts";
import type { SubagentRestoreEvent } from "./subagent-restore.ts";
import {
  type AppRequest,
  checkThread,
  pinDirectory,
  type Refusal,
  refusalMessage,
  requestedEffort,
  requestedMode,
  requestedModel,
  type Thread,
} from "./thread-request.ts";
import type { ThreadValues } from "./thread-values.ts";

type SubagentsReadTag = InferErr<
  Awaited<ReturnType<typeof readClaudeSubagents>>
>["_tag"];

export type RouteEvent =
  | CompatibilityLogEvent
  | ResponseEvent
  | { event: "claude_request_refused"; method: RefusedMethod; reason: Refusal }
  | HistoryEvent
  | SubagentRestoreEvent<{ _tag: SubagentsReadTag }>;

type Turns = {
  adoptFork: (
    threadId: string,
    thread: Thread,
    sourceId: string,
  ) => Promise<void>;
  startTurn: (
    request: AppRequest,
    fallbackCwd: string | undefined,
  ) => Refusal | null;
  compactThread: (request: AppRequest) => void;
  steerTurn: (request: AppRequest) => void;
  interruptTurn: (request: AppRequest) => void;
  reject: (request: AppRequest, message: string) => void;
  answerRequest: (response: Record<string, unknown>) => boolean;
  liveTurnOf: (threadId: string) => LiveTurn | null;
};

type RouterThreads = Pick<
  ThreadValues,
  | "isClaudeThread"
  | "threadOf"
  | "cloudOf"
  | "adopt"
  | "changeModel"
  | "selectMode"
  | "modeOf"
  | "selectEffort"
  | "effortOf"
  | "takePicked"
>;

type RouterDeps = {
  turns: Turns;
  threads: RouterThreads;
  log: (event: RouteEvent) => void;
  // observe answering false refuses the turn, so a created thread on an unexpected model never starts.
  delegations: Pick<DelegationWatch, "observe" | "started">;
  history: History;
  claudeModels: ModelCatalog["models"];
  effortRule: EffortRule;
  subagents: Pick<
    SubagentRequests,
    "isChild" | "answer" | "withChildren" | "listedParentOf" | "remember"
  >;
  revert: (
    method: "thread/revert" | "thread/rollback",
    request: AppRequest,
  ) => Promise<void>;
  sideChats: SideChats;
};

type SideChats = ReturnType<typeof createSideChats>;

type RefusedMethod = (typeof REFUSED_METHODS)[number];

type History = ReturnType<typeof createHistoryRequests>;

type AppCall = {
  method: string;
  line: Buffer;
  message: Record<string, unknown>;
  request: AppRequest;
};

type AppHandler = (call: AppCall) => Buffer | null | Promise<Buffer | null>;

// Lines that are not Claude requests pass as the same bytes; server requests and app responses share ids with the other direction, so only lines with a method are read as app requests and only lines without one as server responses.
export const createRouter = ({
  turns,
  threads,
  log,
  delegations,
  history,
  claudeModels,
  effortRule,
  subagents,
  revert,
  sideChats,
}: RouterDeps) => {
  const pending = new Map<AppRequest["id"], Pending>();
  const compatibility = createCompatibility(log);
  // A Codex thread switched to Claude by turn/start needs a working directory that the request itself may not carry.
  const cwds = new Map<string, string>();
  const responses = createServerResponses({
    turns,
    threads,
    sideChats,
    subagents,
    compatibility,
    claudeModels,
    effortRule,
    rememberCwd: (threadId, cwd) => cwds.set(threadId, cwd),
    log,
  });

  const fromApp = (line: Buffer): Buffer | null | Promise<Buffer | null> => {
    const message = parseMessage(line);
    if (message === null) return line;
    // The app's answers to the bridge's own prompts never reach the server, which did not ask them.
    if (typeof message.method !== "string") {
      return turns.answerRequest(message) ? null : line;
    }
    const { method } = message;
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return line;
    const params = isObject(message.params) ? message.params : {};
    const request = { id, params };
    if (
      compatibility.isIncompatible() &&
      isRefusedMethod(method) &&
      (isClaudeModel(requestedModel(params)) ||
        threads.isClaudeThread(params.threadId) ||
        subagents.isChild(params.threadId))
    ) {
      return refuseIncompatible(method, request);
    }
    // A Claude subagent's thread exists only in the bridge.
    if (subagents.isChild(params.threadId)) {
      if (isHistoryMethod(method)) {
        void history.answer(method, request);
      } else {
        void subagents.answer(method, request);
      }
      return null;
    }
    const handler = appHandlers.get(method);
    return handler === undefined
      ? line
      : handler({ method, line, message, request });
  };

  const refuseIncompatible = (method: RefusedMethod, request: AppRequest) => {
    const { params } = request;
    if (method === "turn/start" && !noteDelegation(params, true)) {
      refuse("turn/start", request, "model_mismatch");
      return null;
    }
    refuse(method, request, "codex_incompatible");
    if (method === "turn/start") noteStarted(params, "codex_incompatible");
    return null;
  };

  // The first turn/start of a thread made by create_thread is the only place its real id meets the thread that asked for it.
  const noteDelegation = (params: Record<string, unknown>, claude: boolean) => {
    const source = delegationSource(params);
    if (source === null || typeof params.threadId !== "string") return true;
    return delegations.observe(
      source,
      params.threadId,
      {
        model: requestedModel(params) ?? null,
        effort: requestedEffort(params) ?? null,
      },
      claude,
    );
  };

  // A Claude first turn the bridge refused never ran, so its creator must not be told it started.
  const noteStarted = (
    params: Record<string, unknown>,
    refusal: Refusal | null,
  ) => {
    if (typeof params.threadId === "string") {
      delegations.started(params.threadId, refusal);
    }
  };

  const awaitResponse = (
    { request: { id }, line }: AppCall,
    response: Pending,
  ) => {
    pending.set(id, response);
    return line;
  };

  const forClaudeThread =
    (handle: AppHandler): AppHandler =>
    (call) =>
      threads.isClaudeThread(call.request.params.threadId)
        ? handle(call)
        : call.line;

  const routeThreadList = (call: AppCall) => {
    const { id, params } = call.request;
    const parent = subagents.listedParentOf(params);
    if (
      parent !== null &&
      (threads.isClaudeThread(parent) || subagents.isChild(parent))
    ) {
      pending.set(id, { kind: "childList", params });
    }
    return call.line;
  };

  const routeTurnStart = ({ line, request }: AppCall) => {
    const { params } = request;
    const handOver =
      typeof params.threadId === "string"
        ? sideChats.beforeTurn(params.threadId, requestedModel(params))
        : null;
    if (handOver !== null) {
      return handOver.then((refusal) => {
        if (refusal === null) return line;
        refuse("turn/start", request, refusal);
        return null;
      });
    }
    const claude =
      isClaudeModel(requestedModel(params)) ||
      threads.isClaudeThread(params.threadId);
    if (!noteDelegation(params, claude)) {
      refuse("turn/start", request, "model_mismatch");
      return null;
    }
    if (!claude) return line;
    noteStarted(params, turns.startTurn(request, cwdOf(params)));
    return null;
  };

  const routeTurnSteer = ({ line, request }: AppCall) => {
    const { params } = request;
    if (sideChats.isStopped(String(params.threadId))) {
      refuse("turn/steer", request, "side_chat_stopped");
      return null;
    }
    if (!threads.isClaudeThread(params.threadId)) return line;
    turns.steerTurn(request);
    return null;
  };

  const routeThreadRead = ({ line, request }: AppCall) => {
    const { id, params } = request;
    if (!threads.isClaudeThread(params.threadId)) return line;
    pending.set(id, {
      kind: "threadRead",
      threadId: String(params.threadId),
      history:
        params.includeTurns === true
          ? history.load(String(params.threadId))
          : null,
    });
    return line;
  };

  // The server creates the thread on its default model, so a Claude model never reaches it; a resumed Claude thread stays where it started, and the server is told that directory.
  const routeThreadOpen = (call: AppCall) => {
    const { method, message, request } = call;
    const threadId =
      method === "thread/resume" && typeof request.params.threadId === "string"
        ? request.params.threadId
        : undefined;
    const known =
      threadId === undefined ? undefined : threads.threadOf(threadId);
    const params =
      known === undefined
        ? request.params
        : pinDirectory(request.params, known);
    if (threadId !== undefined && known !== undefined) {
      const checked = checkThread(params, known, undefined);
      if ("refusal" in checked) {
        refuse("thread/resume", request, checked.refusal);
        return null;
      }
      if (checked.thread.model !== known.model) {
        threads.changeModel(threadId, checked.thread.model);
      }
    }
    const created = method === "thread/start" && isClaudeModel(params.model);
    const reopened = threadId !== undefined && known !== undefined;
    awaitResponse(
      call,
      openingThread(params, {
        createdModel: created ? String(params.model) : null,
        history: reopened ? history.load(threadId) : null,
      }),
    );
    if (!isClaudeModel(params.model)) {
      return params === request.params
        ? call.line
        : encode({ ...message, params });
    }
    return encodeWithoutParams(message, params, ["model"]);
  };

  // The server copies its own record of the thread, which holds none of the Claude conversation, so the fork learns of it here.
  // A side chat opened on a Codex model stays on Codex, and is told where the Claude conversation stood, which it is handed with its first message.
  const routeFork = (call: AppCall) => {
    const { line, message, request } = call;
    const { params } = request;
    const sideChat = params.ephemeral === true;
    const instructions =
      typeof params.developerInstructions === "string"
        ? params.developerInstructions
        : null;
    const requested = requestedModel(params);
    const fromTurn = params.lastTurnId != null || params.beforeTurnId != null;
    if (!threads.isClaudeThread(params.threadId)) {
      if (!sideChat || fromTurn || typeof params.threadId !== "string") {
        return line;
      }
      return routeCodexSideChat(call, {
        parentId: params.threadId,
        instructions,
        requested,
      });
    }
    const sourceId = String(params.threadId);
    // A Cloud thread's conversation runs on claude.ai, and a fork would continue its local copy here instead.
    if (threads.cloudOf(sourceId) !== null) {
      refuse("thread/fork", request, "cloud_unsupported");
      return null;
    }
    // Claude's conversation is forked whole, so a fork from an earlier turn would carry the turns after it.
    if (fromTurn) {
      refuse("thread/fork", request, "unsupported_request");
      return null;
    }
    const source = threads.threadOf(sourceId);
    const codex =
      sideChat && requested !== undefined && !isClaudeModel(requested);
    // Claude's conversation stays where the source runs, so a Claude fork opens there whatever directory the app sends.
    const forked =
      codex || source === undefined ? params : pinDirectory(params, source);
    if (!codex) {
      const checked = checkThread(forked, source, undefined);
      if ("refusal" in checked) {
        refuse("thread/fork", request, checked.refusal);
        return null;
      }
    }
    const open = (opened: Opened | null) => {
      awaitResponse(
        call,
        openingThread(forked, {
          forkOf: codex ? null : sourceId,
          sideChat: opened,
        }),
      );
      return forked === params ? line : encode({ ...message, params: forked });
    };
    if (!sideChat || source === undefined) return open(null);
    // A Claude side chat whose point is unread still runs on Claude, as before; only a Codex one would start without the conversation.
    return sideChats.pointOf(sourceId, source).then((point) => {
      if (point.isErr() && codex) {
        refuse("thread/fork", request, "side_chat_unreadable");
        return null;
      }
      return open({
        parent: point.isOk()
          ? { agent: "Claude", point: point.value }
          : { agent: "Claude", unread: true },
        instructions,
        model: requested,
      });
    });
  };

  // The server keeps no turns of an ephemeral fork, so the main thread is read while the fork is asked for; a side chat opened on Claude is refused rather than started without it, and the server never sees the Claude model.
  const routeCodexSideChat = (
    call: AppCall,
    {
      parentId,
      instructions,
      requested,
    }: {
      parentId: string;
      instructions: string | null;
      requested: string | undefined;
    },
  ) => {
    const { line, message, request } = call;
    const { params } = request;
    const claude = isClaudeModel(requested);
    return sideChats.referenceOf(parentId).then((reference) => {
      if (reference.isErr() && claude) {
        refuse("thread/fork", request, "side_chat_unreadable");
        return null;
      }
      awaitResponse(
        call,
        openingThread(params, {
          createdModel: claude ? requested : null,
          sideChat: {
            parent: reference.isOk()
              ? { agent: "Codex", reference: reference.value }
              : { agent: "Codex", unread: true },
            instructions,
            model: requested,
          },
        }),
      );
      if (!claude) return line;
      return encodeWithoutParams(message, params, ["model"]);
    });
  };

  // Settings that do not reach Claude, such as the approval policy, still go to the server; only what Claude would have to follow is checked.
  const routeSettingsUpdate = ({ line, message, request }: AppCall) => {
    const { params } = request;
    const threadId = params.threadId;
    if (typeof threadId !== "string") return line;
    const sideChat = sideChats.beforeSettings(threadId, requestedModel(params));
    if (sideChat === "pass") return line;
    if (sideChat !== null) {
      refuse("thread/settings/update", request, sideChat);
      return null;
    }
    const known = threads.threadOf(threadId);
    if (known === undefined && !isClaudeModel(requestedModel(params))) {
      return line;
    }
    const checked = checkThread(params, known, cwdOf(params));
    if ("refusal" in checked) {
      refuse("thread/settings/update", request, checked.refusal);
      return null;
    }
    if (known === undefined) threads.adopt(threadId, checked.thread);
    else if (checked.thread.model !== known.model) {
      threads.changeModel(threadId, checked.thread.model);
    }
    const mode = requestedMode(params);
    if (mode !== undefined) threads.selectMode(threadId, mode);
    const effort = requestedEffort(params);
    if (effort !== undefined) threads.selectEffort(threadId, effort);
    // A Claude level such as max would be refused by the server's Codex model.
    if (
      !("model" in params) &&
      !("collaborationMode" in params) &&
      !("effort" in params)
    ) {
      return line;
    }
    return encodeWithoutParams(message, params, [
      "model",
      "collaborationMode",
      "effort",
    ]);
  };

  const refuse = (
    method: RefusedMethod,
    request: AppRequest,
    reason: Refusal,
  ) => {
    turns.reject(request, refusalMessage(reason));
    log({ event: "claude_request_refused", method, reason });
  };

  const cwdOf = (params: Record<string, unknown>) => {
    if (typeof params.cwd === "string") return params.cwd;
    return typeof params.threadId === "string"
      ? cwds.get(params.threadId)
      : undefined;
  };

  const appHandlers = new Map<string, AppHandler>([
    ["initialize", (call) => awaitResponse(call, { kind: "initialize" })],
    ["model/list", (call) => awaitResponse(call, { kind: "modelList" })],
    ["thread/start", routeThreadOpen],
    ["thread/resume", routeThreadOpen],
    ["thread/fork", routeFork],
    ["thread/list", routeThreadList],
    ["turn/start", routeTurnStart],
    ["turn/steer", routeTurnSteer],
    [
      "turn/interrupt",
      forClaudeThread(({ request }) => {
        turns.interruptTurn(request);
        return null;
      }),
    ],
    ...REVERT_METHODS.map((method): [string, AppHandler] => [
      method,
      forClaudeThread(({ request }) => {
        void revert(method, request);
        return null;
      }),
    ]),
    ["thread/settings/update", routeSettingsUpdate],
    ["thread/read", routeThreadRead],
    // The server would compact its own record, which holds none of the Claude conversation.
    [
      "thread/compact/start",
      forClaudeThread(({ request }) => {
        turns.compactThread(request);
        return null;
      }),
    ],
    // The server would run this on its own model with none of the Claude conversation.
    [
      "review/start",
      forClaudeThread(({ request }) => {
        refuse("review/start", request, "unsupported_request");
        return null;
      }),
    ],
    ...HISTORY_METHODS.map((method): [string, AppHandler] => [
      method,
      forClaudeThread(({ request }) => {
        void history.answer(method, request);
        return null;
      }),
    ]),
  ]);

  // The substring check only skips parsing; the method decides, since a response can carry the same text in its thread history.
  const fromServer = (line: Buffer): Buffer | Promise<Buffer> => {
    if (pending.size === 0 && !line.includes(SETTINGS_UPDATED)) return line;
    const message = parseMessage(line);
    if (message === null) return line;
    if (message.method === SETTINGS_UPDATED) {
      return responses.rewriteSettingsUpdated(message) ?? line;
    }
    if (message.method !== undefined) return line;
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return line;
    const request = pending.get(id);
    if (request === undefined) return line;
    pending.delete(id);
    return responses.rewrite(request, line, message);
  };

  return { fromApp, fromServer };
};

export const serializeRouteEvent = (entry: RouteEvent) => {
  switch (entry.event) {
    case "claude_request_refused":
      return { event: entry.event, method: entry.method, reason: entry.reason };
    case "model_id_collision":
      return { event: entry.event, model: entry.model };
    case "codex_incompatible":
      return {
        event: entry.event,
        reason: entry.reason,
        version: entry.version,
      };
    case "codex_version":
      return {
        event: entry.event,
        version: entry.version,
        verified: entry.verified,
      };
    case "claude_history_served":
      return {
        event: entry.event,
        method: entry.method,
        thread: entry.thread,
        excludeTurns: entry.excludeTurns,
        initialPage: entry.initialPage,
        picked: entry.picked,
        turns: entry.turns,
        newest: entry.newest,
      };
    case "claude_history_answered":
      return {
        event: entry.event,
        method: entry.method,
        thread: entry.thread,
        live: entry.live,
        turn: entry.turn,
        cursor: entry.cursor,
        returned: entry.returned,
      };
    case "claude_history_unreadable":
    case "claude_subagents_unreadable":
      return { event: entry.event, error: entry.error };
    case "claude_subagents_unrestored":
      return { event: entry.event };
  }
};

const SETTINGS_UPDATED = "thread/settings/updated";

const REFUSED_METHODS = [
  "thread/start",
  "thread/fork",
  "turn/start",
  "turn/steer",
  "thread/resume",
  "thread/settings/update",
  "review/start",
  "thread/compact/start",
] as const;

const REVERT_METHODS = ["thread/revert", "thread/rollback"] as const;

const isRefusedMethod = (method: string): method is RefusedMethod =>
  (REFUSED_METHODS as readonly string[]).includes(method);
