import { resolve } from "node:path";
import { isObject } from "../shared/object.ts";
import { isClaudeModel } from "./models.ts";

export type Thread = { model: string; cwd: string };

export type AppRequest = {
  id: string | number;
  params: Record<string, unknown>;
};

export type Refusal = keyof typeof REFUSAL_MESSAGES;

// The app spreads its last collaboration mode into requests while model carries the new choice (App 26.924), so model is read first and the mode only fills in when model is absent.
export const requestedModel = (params: Record<string, unknown>) => {
  if (typeof params.model === "string") return params.model;
  const settings = collaborationMode(params)?.settings;
  return isObject(settings) && typeof settings.model === "string"
    ? settings.model
    : undefined;
};

// fallbackCwd is where the server last reported a Codex thread, since a request that switches it to Claude may not carry its directory.
// A thread may move to another Claude model, but Claude keeps running where the thread started, so a new directory is refused.
// TODO: accept plan mode once P9 relays the plan approval to the app.
export const checkThread = (
  params: Record<string, unknown>,
  known: Thread | undefined,
  fallbackCwd: string | undefined,
): { thread: Thread } | { refusal: Refusal } => {
  const model = requestedModel(params) ?? known?.model;
  if (!isClaudeModel(model)) return { refusal: "codex_model" };
  if (requestsPlanMode(params)) return { refusal: "plan_mode" };
  if (known !== undefined) {
    return typeof params.cwd === "string" &&
      !isSameDirectory(params.cwd, known.cwd)
      ? { refusal: "directory_change" }
      : { thread: { model, cwd: known.cwd } };
  }
  const cwd = typeof params.cwd === "string" ? params.cwd : fallbackCwd;
  return cwd === undefined
    ? { refusal: "directory_unknown" }
    : { thread: { model, cwd } };
};

export const refusalMessage = (refusal: Refusal) => REFUSAL_MESSAGES[refusal];

const requestsPlanMode = (params: Record<string, unknown>) => {
  const mode = collaborationMode(params)?.mode;
  return mode !== undefined && mode !== "default";
};

// Spelling differences such as a trailing slash do not change the directory; symlinks are not resolved, since that needs the file system.
const isSameDirectory = (a: string, b: string) => resolve(a) === resolve(b);

const collaborationMode = (params: Record<string, unknown>) =>
  isObject(params.collaborationMode) ? params.collaborationMode : undefined;

const REFUSAL_MESSAGES = {
  missing_thread: "the request needs a threadId",
  codex_model: "a Claude thread cannot switch to a Codex model",
  plan_mode: "Claude threads do not support plan mode yet",
  directory_change:
    "changing the working directory of a Claude thread is not supported",
  directory_unknown: "the working directory of this thread is unknown",
  text_only: "Claude threads accept text input only",
  turn_running: "a Claude turn is already running on this thread",
  no_running_turn: "no running Claude turn matches the turn id",
  steer_not_sent: "the Claude turn ended before the steer reached it",
  bridge_closing: "the bridge is shutting down",
  thread_not_saved: "the Claude thread could not be saved",
  thread_busy: "the Claude thread cannot start a turn",
  unsupported_request: "this request is not supported on a Claude thread yet",
} as const;
