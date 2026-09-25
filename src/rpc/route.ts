import { parseJson } from "../boundary/json.ts";
import type { AppRequest } from "../turn/controller.ts";
import { isSameDirectory } from "../turn/directory.ts";
import {
  isClaudeModel,
  requestedModel,
  requestsUnsupportedMode,
  withClaudeModels,
} from "../turn/models.ts";

export type RouteEvent = { event: "model_id_collision"; model: string };

type Turns = {
  isClaudeThread: (threadId: unknown) => boolean;
  threadOf: (threadId: string) => Thread | undefined;
  adopt: (threadId: string, thread: Thread) => void;
  startTurn: (request: AppRequest, cwd: string | undefined) => void;
  interruptTurn: (request: AppRequest) => void;
  refuse: (request: AppRequest, message: string) => void;
};

type Thread = { model: string; cwd: string };

type RequestId = string | number;

// createdModel is the Claude model a thread/start asked for, which the server never sees.
type Pending =
  | { kind: "modelList" }
  | { kind: "thread"; createdModel: string | null };

// Lines that are not Claude requests pass as the same bytes; server requests and app responses share ids with the other direction, so only lines with a method are read as app requests and only lines without one as server responses.
export const createRouter = (
  turns: Turns,
  log: (event: RouteEvent) => void,
) => {
  const pending = new Map<RequestId, Pending>();
  // A Codex thread switched to Claude by turn/start needs a working directory that the request itself may not carry.
  const cwds = new Map<string, string>();

  const fromApp = (line: Buffer): Buffer | null => {
    const message = parseMessage(line);
    if (message === null || typeof message.method !== "string") return line;
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return line;
    const params = isObject(message.params) ? message.params : {};
    const request = { id, params };
    switch (message.method) {
      case "model/list":
        pending.set(id, { kind: "modelList" });
        return line;
      case "thread/start":
      case "thread/resume":
        return routeThreadOpen(line, message, request);
      case "turn/start":
        if (
          !isClaudeModel(requestedModel(params)) &&
          !turns.isClaudeThread(params.threadId)
        ) {
          return line;
        }
        turns.startTurn(request, cwdOf(params));
        return null;
      case "turn/interrupt":
        if (!turns.isClaudeThread(params.threadId)) return line;
        turns.interruptTurn(request);
        return null;
      case "thread/settings/update":
        return routeSettingsUpdate(line, message, request);
      // TODO: pass steers into the running Claude turn in P10.
      case "turn/steer":
      // The server would run these on its own model with none of the Claude conversation.
      case "review/start":
      case "thread/compact/start":
        if (!turns.isClaudeThread(params.threadId)) return line;
        turns.refuse(
          request,
          `${message.method} is not supported on a Claude thread yet`,
        );
        return null;
      default:
        return line;
    }
  };

  // The server creates the thread on its default model, so a Claude model never reaches it.
  const routeThreadOpen = (
    line: Buffer,
    message: Record<string, unknown>,
    { id, params }: AppRequest,
  ) => {
    const created =
      message.method === "thread/start" && isClaudeModel(params.model);
    pending.set(id, {
      kind: "thread",
      createdModel: created ? String(params.model) : null,
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
    const model = requestedModel(params);
    const known = turns.threadOf(threadId);
    if (known === undefined && !isClaudeModel(model)) return line;
    const cwd = cwdOf(params);
    const thread =
      known ?? (cwd === undefined ? undefined : { model: String(model), cwd });
    if (thread === undefined) {
      turns.refuse(request, "the working directory of this thread is unknown");
      return null;
    }
    // TODO: accept a model or directory change in P10, which restarts the Claude session for it.
    const refusal =
      model !== undefined && model !== thread.model
        ? "changing the model of a Claude thread is not supported yet"
        : requestsUnsupportedMode(params)
          ? "Claude threads do not support plan mode yet"
          : typeof params.cwd === "string" &&
              !isSameDirectory(params.cwd, thread.cwd)
            ? "changing the working directory of a Claude thread is not supported yet"
            : null;
    if (refusal !== null) {
      turns.refuse(request, refusal);
      return null;
    }
    if (known === undefined) turns.adopt(threadId, thread);
    if (!("model" in params) && !("collaborationMode" in params)) return line;
    const { model: _model, collaborationMode: _mode, ...rest } = params;
    return encode({ ...message, params: rest });
  };

  // The substring check only skips parsing; the method decides, since a response can carry the same text in its thread history.
  const fromServer = (line: Buffer): Buffer => {
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
    if (request.kind === "modelList") {
      const listed = withClaudeModels(message.result);
      for (const model of listed.collisions) {
        log({ event: "model_id_collision", model });
      }
      return encode({ ...message, result: listed.result });
    }
    const result = message.result;
    const thread = isObject(result.thread) ? result.thread : {};
    const threadId = thread.id;
    if (typeof threadId !== "string") return line;
    if (typeof result.cwd === "string") cwds.set(threadId, result.cwd);
    if (request.createdModel !== null && typeof result.cwd === "string") {
      turns.adopt(threadId, { model: request.createdModel, cwd: result.cwd });
    }
    const model = turns.threadOf(threadId)?.model;
    if (model === undefined) return line;
    return encode({
      ...message,
      result: {
        ...result,
        model,
        ...("model" in thread && { thread: { ...thread, model } }),
      },
    });
  };

  // The server keeps its own model for a Claude thread, so the app would otherwise show that model after any settings change.
  const rewriteSettingsUpdated = (message: Record<string, unknown>) => {
    const params = isObject(message.params) ? message.params : {};
    const model =
      typeof params.threadId === "string"
        ? turns.threadOf(params.threadId)?.model
        : undefined;
    const settings = params.threadSettings;
    if (model === undefined || !isObject(settings)) return null;
    const mode = settings.collaborationMode;
    return encode({
      ...message,
      params: {
        ...params,
        threadSettings: {
          ...settings,
          model,
          ...(isObject(mode) &&
            isObject(mode.settings) && {
              collaborationMode: {
                ...mode,
                settings: { ...mode.settings, model },
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

const SETTINGS_UPDATED = "thread/settings/updated";

const parseMessage = (line: Buffer) => {
  const parsed = parseJson(line.toString("utf8"));
  return parsed.isOk() && isObject(parsed.value) ? parsed.value : null;
};

const encode = (message: object) => Buffer.from(`${JSON.stringify(message)}\n`);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
