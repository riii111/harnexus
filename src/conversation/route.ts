import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { InferErr } from "better-result";
import {
  type EffortRule,
  isClaudeModel,
  type ModelCatalog,
} from "../infra/claude/models.ts";
import type { readClaudeSubagents } from "../infra/claude/session.ts";
import {
  type CompatibilityEvent,
  compatibilityVersion,
  responseCompatibility,
} from "../infra/codex/compatibility.ts";
import {
  type DelegationWatch,
  delegationSource,
} from "../infra/codex/delegations.ts";
import { codexVersion, isVerifiedCodex } from "../infra/codex/versions.ts";
import { type LiveTurn, withLiveTurn } from "../presentation/history.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import {
  type createHistoryRequests,
  endsLive,
  type HistoryEvent,
  isHistoryMethod,
  withLiveStatus,
  withResumeHistory,
  withTurns,
} from "./history-request.ts";
import { shownEffort, withClaudeModels } from "./model-list.ts";
import type { createSideChats, Opened } from "./side-chat.ts";
import type { SubagentRequests } from "./subagent-requests.ts";
import type { SubagentRestoreEvent } from "./subagent-restore.ts";

type SubagentsReadTag = InferErr<
  Awaited<ReturnType<typeof readClaudeSubagents>>
>["_tag"];

import {
  type AppRequest,
  checkThread,
  type Mode,
  type Refusal,
  refusalMessage,
  requestedEffort,
  requestedMode,
  requestedModel,
  type Thread,
} from "./thread-request.ts";

export type RouteEvent =
  | CompatibilityEvent
  | { event: "model_id_collision"; model: string }
  | { event: "codex_version"; version: string | null; verified: boolean }
  | { event: "claude_request_refused"; method: RefusedMethod; reason: Refusal }
  | {
      event: "claude_history_served";
      method: "thread/resume" | "thread/read";
      thread: string;
      excludeTurns: boolean;
      initialPage: boolean;
      picked: boolean;
      turns: number;
    }
  | HistoryEvent
  | SubagentRestoreEvent<{ _tag: SubagentsReadTag }>;

type Turns = {
  isClaudeThread: (threadId: unknown) => boolean;
  threadOf: (threadId: string) => Thread | undefined;
  adopt: (threadId: string, thread: Thread) => void;
  adoptFork: (
    threadId: string,
    thread: Thread,
    sourceId: string,
  ) => Promise<void>;
  changeModel: (threadId: string, model: string) => void;
  startTurn: (
    request: AppRequest,
    fallbackCwd: string | undefined,
  ) => Refusal | null;
  compactThread: (request: AppRequest) => void;
  steerTurn: (request: AppRequest) => void;
  interruptTurn: (request: AppRequest) => void;
  reject: (request: AppRequest, message: string) => void;
  answerRequest: (response: Record<string, unknown>) => boolean;
  selectMode: (threadId: string, mode: Mode) => void;
  modeOf: (threadId: string) => Mode | undefined;
  selectEffort: (threadId: string, effort: string) => void;
  effortOf: (threadId: string) => EffortLevel | null;
  effortRule: EffortRule;
  liveTurnOf: (threadId: string) => LiveTurn | null;
};

type RouterDeps = {
  turns: Turns;
  log: (event: RouteEvent) => void;
  // observe answering false refuses the turn, so a created thread on an unexpected model never starts.
  delegations: Pick<DelegationWatch, "observe" | "started">;
  history: History;
  claudeModels: ModelCatalog["models"];
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

// createdModel is the Claude model a thread/start asked for, which the server never sees; history is the Claude thread's record being read while the server opens the thread; sideChat is where the main conversation stood when a side chat of a Claude thread opened.
type Pending =
  | { kind: "initialize" }
  | { kind: "modelList" }
  | {
      kind: "threadOpen";
      createdModel: string | null;
      forkOf: string | null;
      history: ReturnType<History["load"]> | null;
      params: Record<string, unknown>;
      sideChat: Opened | null;
    }
  | {
      kind: "threadRead";
      threadId: string;
      history: ReturnType<History["load"]> | null;
    }
  | { kind: "childList"; params: Record<string, unknown> };

// Lines that are not Claude requests pass as the same bytes; server requests and app responses share ids with the other direction, so only lines with a method are read as app requests and only lines without one as server responses.
export const createRouter = ({
  turns,
  log,
  delegations,
  history,
  claudeModels,
  subagents,
  revert,
  sideChats,
}: RouterDeps) => {
  const pending = new Map<AppRequest["id"], Pending>();
  // Set by an incompatible initialize or model/list answer; the app then lists no Claude model and a Claude turn is refused rather than handed to Codex, which would run it without the Claude conversation.
  let incompatible = false;
  let serverVersion: string | null = null;
  // A Codex thread switched to Claude by turn/start needs a working directory that the request itself may not carry.
  const cwds = new Map<string, string>();

  const fromApp = (line: Buffer): Buffer | null | Promise<Buffer | null> => {
    const message = parseMessage(line);
    if (message === null) return line;
    // The app's answers to the bridge's own prompts never reach the server, which did not ask them.
    if (typeof message.method !== "string") {
      return turns.answerRequest(message) ? null : line;
    }
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return line;
    const params = isObject(message.params) ? message.params : {};
    const request = { id, params };
    if (
      incompatible &&
      REFUSED_METHODS.some((method) => method === message.method) &&
      (isClaudeModel(requestedModel(params)) ||
        turns.isClaudeThread(params.threadId) ||
        subagents.isChild(params.threadId))
    ) {
      if (message.method === "turn/start" && !noteDelegation(params, true)) {
        refuse("turn/start", request, "model_mismatch");
        return null;
      }
      refuse(message.method as RefusedMethod, request, "codex_incompatible");
      if (message.method === "turn/start")
        noteStarted(params, "codex_incompatible");
      return null;
    }
    // A Claude subagent's thread exists only in the bridge.
    if (subagents.isChild(params.threadId)) {
      if (isHistoryMethod(message.method)) {
        void history.answer(message.method, request);
      } else {
        void subagents.answer(message.method, request);
      }
      return null;
    }
    switch (message.method) {
      case "initialize":
        pending.set(id, { kind: "initialize" });
        return line;
      case "model/list":
        pending.set(id, { kind: "modelList" });
        return line;
      case "thread/start":
      case "thread/resume":
        return routeThreadOpen(line, message, request);
      case "thread/fork":
        return routeFork(line, message, request);
      case "thread/list": {
        const parent = subagents.listedParentOf(params);
        if (
          parent !== null &&
          (turns.isClaudeThread(parent) || subagents.isChild(parent))
        ) {
          pending.set(id, { kind: "childList", params });
        }
        return line;
      }
      case "turn/start": {
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
          turns.isClaudeThread(params.threadId);
        if (!noteDelegation(params, claude)) {
          refuse("turn/start", request, "model_mismatch");
          return null;
        }
        if (!claude) return line;
        if (incompatible) {
          refuse("turn/start", request, "codex_incompatible");
          noteStarted(params, "codex_incompatible");
          return null;
        }
        noteStarted(params, turns.startTurn(request, cwdOf(params)));
        return null;
      }
      case "turn/steer":
        if (sideChats.isStopped(String(params.threadId))) {
          refuse("turn/steer", request, "side_chat_stopped");
          return null;
        }
        if (!turns.isClaudeThread(params.threadId)) return line;
        if (incompatible) {
          refuse("turn/steer", request, "codex_incompatible");
          return null;
        }
        turns.steerTurn(request);
        return null;
      case "turn/interrupt":
        if (!turns.isClaudeThread(params.threadId)) return line;
        turns.interruptTurn(request);
        return null;
      case "thread/revert":
      case "thread/rollback":
        if (!turns.isClaudeThread(params.threadId)) return line;
        void revert(message.method, request);
        return null;
      case "thread/settings/update":
        return routeSettingsUpdate(line, message, request);
      case "thread/read":
        if (!turns.isClaudeThread(params.threadId)) return line;
        pending.set(id, {
          kind: "threadRead",
          threadId: String(params.threadId),
          history:
            params.includeTurns === true
              ? history.load(String(params.threadId))
              : null,
        });
        return line;
      // The server would compact its own record, which holds none of the Claude conversation.
      case "thread/compact/start":
        if (!turns.isClaudeThread(params.threadId)) return line;
        if (incompatible) {
          refuse("thread/compact/start", request, "codex_incompatible");
          return null;
        }
        turns.compactThread(request);
        return null;
      // The server would run this on its own model with none of the Claude conversation.
      case "review/start":
        if (!turns.isClaudeThread(params.threadId)) return line;
        refuse(message.method, request, "unsupported_request");
        return null;
      default:
        if (!isHistoryMethod(message.method)) return line;
        if (!turns.isClaudeThread(params.threadId)) return line;
        void history.answer(message.method, request);
        return null;
    }
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

  // The server creates the thread on its default model, so a Claude model never reaches it; a resume that would move a Claude thread is refused, since Claude keeps running where the thread started.
  const routeThreadOpen = (
    line: Buffer,
    message: Record<string, unknown>,
    request: AppRequest,
  ) => {
    const { id, params } = request;
    if (
      incompatible &&
      message.method === "thread/start" &&
      isClaudeModel(params.model)
    ) {
      refuse("thread/start", request, "codex_incompatible");
      return null;
    }
    const threadId =
      message.method === "thread/resume" && typeof params.threadId === "string"
        ? params.threadId
        : undefined;
    const known = threadId === undefined ? undefined : turns.threadOf(threadId);
    if (threadId !== undefined && known !== undefined) {
      const checked = checkThread(params, known, undefined);
      if ("refusal" in checked) {
        refuse("thread/resume", request, checked.refusal);
        return null;
      }
      if (checked.thread.model !== known.model) {
        turns.changeModel(threadId, checked.thread.model);
      }
    }
    const created =
      message.method === "thread/start" && isClaudeModel(params.model);
    const reopened = threadId !== undefined && known !== undefined;
    pending.set(id, {
      kind: "threadOpen",
      createdModel: created ? String(params.model) : null,
      forkOf: null,
      history: reopened ? history.load(threadId) : null,
      params,
      sideChat: null,
    });
    if (!isClaudeModel(params.model)) return line;
    const { model: _model, ...rest } = params;
    return encode({ ...message, params: rest });
  };

  // The server copies its own record of the thread, which holds none of the Claude conversation, so the fork learns of it here.
  // A side chat opened on a Codex model stays on Codex, and is told where the Claude conversation stood, which it is handed with its first message.
  const routeFork = (
    line: Buffer,
    message: Record<string, unknown>,
    request: AppRequest,
  ) => {
    const { id, params } = request;
    const sideChat = params.ephemeral === true;
    const instructions =
      typeof params.developerInstructions === "string"
        ? params.developerInstructions
        : null;
    const requested = requestedModel(params);
    const fromTurn = params.lastTurnId != null || params.beforeTurnId != null;
    if (!turns.isClaudeThread(params.threadId)) {
      if (!sideChat || fromTurn || typeof params.threadId !== "string") {
        return line;
      }
      return routeCodexSideChat(line, message, request, {
        parentId: params.threadId,
        instructions,
        requested,
      });
    }
    const sourceId = String(params.threadId);
    // Claude's conversation is forked whole, so a fork from an earlier turn would carry the turns after it.
    if (fromTurn) {
      refuse("thread/fork", request, "unsupported_request");
      return null;
    }
    const source = turns.threadOf(sourceId);
    const codex =
      sideChat && requested !== undefined && !isClaudeModel(requested);
    // Claude's conversation stays where the source runs, so a fork into another directory would work on the source's files.
    if (!codex) {
      const checked = checkThread(params, source, undefined);
      if ("refusal" in checked) {
        refuse("thread/fork", request, checked.refusal);
        return null;
      }
    }
    const open = (opened: Opened | null) => {
      pending.set(id, {
        kind: "threadOpen",
        createdModel: null,
        forkOf: codex ? null : sourceId,
        history: null,
        params,
        sideChat: opened,
      });
      return line;
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
    line: Buffer,
    message: Record<string, unknown>,
    request: AppRequest,
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
    const { id, params } = request;
    const claude = isClaudeModel(requested);
    if (claude && incompatible) {
      refuse("thread/fork", request, "codex_incompatible");
      return null;
    }
    return sideChats.referenceOf(parentId).then((reference) => {
      if (reference.isErr() && claude) {
        refuse("thread/fork", request, "side_chat_unreadable");
        return null;
      }
      pending.set(id, {
        kind: "threadOpen",
        createdModel: claude ? requested : null,
        forkOf: null,
        history: null,
        params,
        sideChat: {
          parent: reference.isOk()
            ? { agent: "Codex", reference: reference.value }
            : { agent: "Codex", unread: true },
          instructions,
          model: requested,
        },
      });
      if (!claude) return line;
      const { model: _model, ...rest } = params;
      return encode({ ...message, params: rest });
    });
  };

  // Settings that do not reach Claude, such as the approval policy, still go to the server; only what Claude would have to follow is checked.
  const routeSettingsUpdate = (
    line: Buffer,
    message: Record<string, unknown>,
    request: AppRequest,
  ) => {
    const { params } = request;
    const threadId = params.threadId;
    if (typeof threadId !== "string") return line;
    const sideChat = sideChats.beforeSettings(threadId, requestedModel(params));
    if (sideChat === "pass") return line;
    if (sideChat !== null) {
      refuse("thread/settings/update", request, sideChat);
      return null;
    }
    const known = turns.threadOf(threadId);
    if (known === undefined && !isClaudeModel(requestedModel(params))) {
      return line;
    }
    const checked = checkThread(params, known, cwdOf(params));
    if ("refusal" in checked) {
      refuse("thread/settings/update", request, checked.refusal);
      return null;
    }
    if (known === undefined) turns.adopt(threadId, checked.thread);
    else if (checked.thread.model !== known.model) {
      turns.changeModel(threadId, checked.thread.model);
    }
    const mode = requestedMode(params);
    if (mode !== undefined) turns.selectMode(threadId, mode);
    const effort = requestedEffort(params);
    if (effort !== undefined) turns.selectEffort(threadId, effort);
    // A Claude level such as max would be refused by the server's Codex model.
    if (
      !("model" in params) &&
      !("collaborationMode" in params) &&
      !("effort" in params)
    ) {
      return line;
    }
    const {
      model: _model,
      collaborationMode: _mode,
      effort: _effort,
      ...rest
    } = params;
    return encode({ ...message, params: rest });
  };

  const refuse = (
    method: RefusedMethod,
    request: AppRequest,
    reason: Refusal,
  ) => {
    turns.reject(request, refusalMessage(reason));
    log({ event: "claude_request_refused", method, reason });
  };

  // The substring check only skips parsing; the method decides, since a response can carry the same text in its thread history.
  // A response that opens a Claude thread waits for its history, which holds back the server's later lines until it is read.
  const fromServer = (line: Buffer): Buffer | Promise<Buffer> => {
    if (pending.size === 0 && !line.includes(SETTINGS_UPDATED)) return line;
    const message = parseMessage(line);
    if (message === null) return line;
    if (message.method === SETTINGS_UPDATED) {
      return rewriteSettingsUpdated(message) ?? line;
    }
    if (message.method !== undefined) return line;
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return line;
    const request = pending.get(id);
    if (request === undefined) return line;
    pending.delete(id);
    if (request.kind === "initialize" || request.kind === "modelList") {
      const reason = responseCompatibility(request.kind, message);
      if (reason !== null) {
        if (!incompatible) {
          incompatible = true;
          log({ event: "codex_incompatible", reason, version: serverVersion });
        }
        return line;
      }
    }
    if (!isObject(message.result)) return line;
    if (request.kind === "initialize") {
      const version = codexVersion(message.result.userAgent);
      const verified = isVerifiedCodex(version);
      serverVersion = compatibilityVersion(version);
      log({ event: "codex_version", version, verified });
      return line;
    }
    if (request.kind === "modelList") {
      if (incompatible) return line;
      const listed = withClaudeModels(
        message.result,
        claudeModels(),
        turns.effortRule,
      );
      for (const model of listed.collisions) {
        log({ event: "model_id_collision", model });
      }
      return encode({ ...message, result: listed.result });
    }
    const result = message.result;
    if (request.kind === "childList") {
      return encode({
        ...message,
        result: subagents.withChildren(result, request.params),
      });
    }
    // Whether a turn runs is asked as the answer goes out, since it may end while the server answers.
    if (request.kind === "threadRead") {
      if (request.history === null) {
        const live = turns.liveTurnOf(request.threadId) !== null;
        return live
          ? encode({ ...message, result: withLiveStatus(result, live) })
          : line;
      }
      return request.history.then((loaded) => {
        if (loaded.isErr()) return line;
        const shown = withLiveTurn(
          loaded.value,
          turns.liveTurnOf(request.threadId),
        );
        log({
          event: "claude_history_served",
          method: "thread/read",
          thread: threadIdOf(result),
          excludeTurns: false,
          initialPage: false,
          picked: false,
          turns: shown.length,
        });
        return encode({
          ...message,
          result: withLiveStatus(withTurns(result, shown), endsLive(shown)),
        });
      });
    }
    const thread = isObject(result.thread) ? result.thread : {};
    const threadId = thread.id;
    if (typeof threadId !== "string") return line;
    if (typeof result.cwd === "string") cwds.set(threadId, result.cwd);
    if (request.sideChat !== null) {
      sideChats.remember(threadId, request.sideChat);
    }
    if (request.createdModel !== null && typeof result.cwd === "string") {
      turns.adopt(threadId, { model: request.createdModel, cwd: result.cwd });
    }
    const source =
      request.forkOf === null ? undefined : turns.threadOf(request.forkOf);
    // The app is shown the fork only once where its source stood has been read, so nothing the source says after the fork appears reaches it.
    if (request.forkOf !== null && source !== undefined) {
      return turns
        .adoptFork(threadId, source, request.forkOf)
        .then(() => openedResponse(line, message, request, threadId));
    }
    return openedResponse(line, message, request, threadId);
  };

  const openedResponse = (
    line: Buffer,
    message: Record<string, unknown>,
    request: Extract<Pending, { kind: "threadOpen" }>,
    threadId: string,
  ): Buffer | Promise<Buffer> => {
    const result = isObject(message.result) ? message.result : {};
    const thread = isObject(result.thread) ? result.thread : {};
    const model = turns.threadOf(threadId)?.model;
    if (model === undefined) return line;
    const reasoningEffort = shownEffort(turns.effortOf(threadId));
    const opened = {
      ...result,
      model,
      reasoningEffort,
      ...("model" in thread && {
        thread: {
          ...thread,
          model,
          ...("reasoningEffort" in thread && { reasoningEffort }),
        },
      }),
    };
    subagents.remember(opened);
    if (request.history === null) return encode({ ...message, result: opened });
    const { params } = request;
    return request.history.then((loaded) => {
      if (loaded.isErr()) return encode({ ...message, result: opened });
      // Taken only once the history goes out, since a resume the server fails would otherwise use up the pick.
      const picked = history.takePicked(threadId);
      const shown = withLiveTurn(loaded.value, turns.liveTurnOf(threadId));
      log({
        event: "claude_history_served",
        method: "thread/resume",
        thread: threadId.slice(0, 8),
        excludeTurns: params.excludeTurns === true,
        initialPage: isObject(params.initialTurnsPage),
        picked,
        turns: shown.length,
      });
      return encode({
        ...message,
        result: withLiveStatus(
          withResumeHistory(opened, shown, params, picked),
          endsLive(shown),
        ),
      });
    });
  };

  // The server keeps its own model, effort and mode for a Claude thread, and the app shows what this notice reports after any settings change.
  const rewriteSettingsUpdated = (message: Record<string, unknown>) => {
    const params = isObject(message.params) ? message.params : {};
    const threadId =
      typeof params.threadId === "string" ? params.threadId : undefined;
    // The server already reports the Codex model a side chat was switched to before its first message.
    if (threadId !== undefined && sideChats.showsCodex(threadId)) return null;
    const model =
      threadId === undefined ? undefined : turns.threadOf(threadId)?.model;
    const selected =
      threadId === undefined ? undefined : turns.modeOf(threadId);
    const settings = params.threadSettings;
    if (threadId === undefined || model === undefined || !isObject(settings)) {
      return null;
    }
    const effort = shownEffort(turns.effortOf(threadId));
    const mode = settings.collaborationMode;
    return encode({
      ...message,
      params: {
        ...params,
        threadSettings: {
          ...settings,
          model,
          effort,
          ...(isObject(mode) &&
            isObject(mode.settings) && {
              collaborationMode: {
                ...mode,
                ...(selected !== undefined && { mode: selected }),
                settings: {
                  ...mode.settings,
                  model,
                  reasoning_effort: effort,
                },
              },
            }),
        },
      },
    });
  };

  const cwdOf = (params: Record<string, unknown>) => {
    if (typeof params.cwd === "string") return params.cwd;
    return typeof params.threadId === "string"
      ? cwds.get(params.threadId)
      : undefined;
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

// The id's head is enough to tell threads apart in a log without carrying the whole id.
const threadIdOf = (result: Record<string, unknown>) =>
  isObject(result.thread) && typeof result.thread.id === "string"
    ? result.thread.id.slice(0, 8)
    : "";

const parseMessage = (line: Buffer) => {
  const parsed = parseJson(line.toString("utf8"));
  return parsed.isOk() && isObject(parsed.value) ? parsed.value : null;
};

const encode = (message: object) => Buffer.from(`${JSON.stringify(message)}\n`);
