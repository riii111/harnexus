import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import {
  type EffortRule,
  isClaudeModel,
  type ModelCatalog,
} from "../infra/claude/models.ts";
import { delegationSource } from "../infra/codex/delegations.ts";
import { codexVersion, isVerifiedCodex } from "../infra/codex/versions.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import {
  type createHistoryRequests,
  type HistoryEvent,
  isHistoryMethod,
  withResumeHistory,
  withTurns,
} from "./history-request.ts";
import { shownEffort, withClaudeModels } from "./model-list.ts";
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
  | { event: "model_id_collision"; model: string }
  | { event: "codex_version"; version: string | null; verified: boolean }
  | { event: "claude_request_refused"; method: RefusedMethod; reason: Refusal }
  | {
      event: "claude_history_served";
      method: "thread/resume" | "thread/read";
      excludeTurns: boolean;
      initialPage: boolean;
      picked: boolean;
      turns: number;
    }
  | HistoryEvent;

type Turns = {
  isClaudeThread: (threadId: unknown) => boolean;
  threadOf: (threadId: string) => Thread | undefined;
  adopt: (threadId: string, thread: Thread) => void;
  changeModel: (threadId: string, model: string) => void;
  startTurn: (request: AppRequest, fallbackCwd: string | undefined) => void;
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
};

type RefusedMethod = (typeof REFUSED_METHODS)[number];

type History = ReturnType<typeof createHistoryRequests>;

// createdModel is the Claude model a thread/start asked for, which the server never sees; history is the Claude thread's record being read while the server opens the thread.
type Pending =
  | { kind: "initialize" }
  | { kind: "modelList" }
  | {
      kind: "threadOpen";
      createdModel: string | null;
      history: ReturnType<History["load"]> | null;
      picked: boolean;
      params: Record<string, unknown>;
    }
  | { kind: "threadRead"; history: ReturnType<History["load"]> };

// Lines that are not Claude requests pass as the same bytes; server requests and app responses share ids with the other direction, so only lines with a method are read as app requests and only lines without one as server responses.
export const createRouter = (
  turns: Turns,
  log: (event: RouteEvent) => void,
  onDelegated: (sourceThreadId: string, threadId: string) => void,
  history: History,
  claudeModels: ModelCatalog["models"],
  unverifiedCodex: "warn" | "pause",
) => {
  const pending = new Map<AppRequest["id"], Pending>();
  // Set from the server's initialize answer; while paused the app lists no Claude model and a Claude turn is refused rather than handed to Codex, which would run it without the Claude conversation.
  let paused = false;
  // A Codex thread switched to Claude by turn/start needs a working directory that the request itself may not carry.
  const cwds = new Map<string, string>();

  const fromApp = (line: Buffer): Buffer | null => {
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
      case "turn/start":
        noteDelegation(params);
        if (
          !isClaudeModel(requestedModel(params)) &&
          !turns.isClaudeThread(params.threadId)
        ) {
          return line;
        }
        if (paused) {
          refuse("turn/start", request, "claude_paused");
          return null;
        }
        turns.startTurn(request, cwdOf(params));
        return null;
      case "turn/steer":
        if (!turns.isClaudeThread(params.threadId)) return line;
        if (paused) {
          refuse("turn/steer", request, "claude_paused");
          return null;
        }
        turns.steerTurn(request);
        return null;
      case "turn/interrupt":
        if (!turns.isClaudeThread(params.threadId)) return line;
        turns.interruptTurn(request);
        return null;
      case "thread/settings/update":
        return routeSettingsUpdate(line, message, request);
      case "thread/read":
        if (params.includeTurns !== true) return line;
        if (!turns.isClaudeThread(params.threadId)) return line;
        pending.set(id, {
          kind: "threadRead",
          history: history.load(String(params.threadId)),
        });
        return line;
      // The server would compact its own record, which holds none of the Claude conversation.
      case "thread/compact/start":
        if (!turns.isClaudeThread(params.threadId)) return line;
        if (paused) {
          refuse("thread/compact/start", request, "claude_paused");
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
  const noteDelegation = (params: Record<string, unknown>) => {
    const source = delegationSource(params);
    if (source !== null && typeof params.threadId === "string") {
      onDelegated(source, params.threadId);
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
      paused &&
      message.method === "thread/start" &&
      isClaudeModel(params.model)
    ) {
      refuse("thread/start", request, "claude_paused");
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
      history: reopened ? history.load(threadId) : null,
      picked: reopened && history.takePicked(threadId),
      params,
    });
    if (!isClaudeModel(params.model)) return line;
    const { model: _model, ...rest } = params;
    return encode({ ...message, params: rest });
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
    if (!isObject(message.result)) return line;
    if (request.kind === "initialize") {
      const version = codexVersion(message.result.userAgent);
      const verified = isVerifiedCodex(version);
      paused = !verified && unverifiedCodex === "pause";
      log({ event: "codex_version", version, verified });
      return line;
    }
    if (request.kind === "modelList") {
      if (paused) return line;
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
    if (request.kind === "threadRead") {
      return request.history.then((loaded) => {
        if (loaded.isErr()) return line;
        log({
          event: "claude_history_served",
          method: "thread/read",
          excludeTurns: false,
          initialPage: false,
          picked: false,
          turns: loaded.value.length,
        });
        return encode({ ...message, result: withTurns(result, loaded.value) });
      });
    }
    const thread = isObject(result.thread) ? result.thread : {};
    const threadId = thread.id;
    if (typeof threadId !== "string") return line;
    if (typeof result.cwd === "string") cwds.set(threadId, result.cwd);
    if (request.createdModel !== null && typeof result.cwd === "string") {
      turns.adopt(threadId, { model: request.createdModel, cwd: result.cwd });
    }
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
    if (request.history === null) return encode({ ...message, result: opened });
    const { params, picked } = request;
    return request.history.then((loaded) => {
      if (loaded.isErr()) return encode({ ...message, result: opened });
      log({
        event: "claude_history_served",
        method: "thread/resume",
        excludeTurns: params.excludeTurns === true,
        initialPage: isObject(params.initialTurnsPage),
        picked,
        turns: loaded.value.length,
      });
      return encode({
        ...message,
        result: withResumeHistory(opened, loaded.value, params, picked),
      });
    });
  };

  // The server keeps its own model, effort and mode for a Claude thread, and the app shows what this notice reports after any settings change.
  const rewriteSettingsUpdated = (message: Record<string, unknown>) => {
    const params = isObject(message.params) ? message.params : {};
    const threadId =
      typeof params.threadId === "string" ? params.threadId : undefined;
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
        excludeTurns: entry.excludeTurns,
        initialPage: entry.initialPage,
        picked: entry.picked,
        turns: entry.turns,
      };
    case "claude_history_unreadable":
      return { event: entry.event, error: entry.error };
  }
};

const SETTINGS_UPDATED = "thread/settings/updated";

const REFUSED_METHODS = [
  "thread/start",
  "turn/start",
  "turn/steer",
  "thread/resume",
  "thread/settings/update",
  "review/start",
  "thread/compact/start",
] as const;

const parseMessage = (line: Buffer) => {
  const parsed = parseJson(line.toString("utf8"));
  return parsed.isOk() && isObject(parsed.value) ? parsed.value : null;
};

const encode = (message: object) => Buffer.from(`${JSON.stringify(message)}\n`);
