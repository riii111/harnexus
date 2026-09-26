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
// TODO: accept a model or working directory change in P10, which restarts the Claude session for it.
export const checkThread = (
  params: Record<string, unknown>,
  known: Thread | undefined,
  fallbackCwd: string | undefined,
): { thread: Thread } | { refusal: Refusal } => {
  const model = requestedModel(params) ?? known?.model;
  if (!isClaudeModel(model)) return { refusal: "codex_model" };
  if (known !== undefined && model !== known.model) {
    return { refusal: "model_change" };
  }
  if (known !== undefined) {
    return typeof params.cwd === "string" &&
      !isSameDirectory(params.cwd, known.cwd)
      ? { refusal: "directory_change" }
      : { thread: known };
  }
  const cwd = typeof params.cwd === "string" ? params.cwd : fallbackCwd;
  return cwd === undefined
    ? { refusal: "directory_unknown" }
    : { thread: { model, cwd } };
};

// A turn checked before another turn saved the thread would otherwise run on the settings that turn saved.
export const savedThreadChange = (
  requested: Thread,
  saved: Thread,
): Refusal | null => {
  if (requested.model !== saved.model) return "model_change";
  return isSameDirectory(requested.cwd, saved.cwd) ? null : "directory_change";
};

export const refusalMessage = (refusal: Refusal) => REFUSAL_MESSAGES[refusal];

export type Mode = "plan" | "default";

export const requestedMode = (
  params: Record<string, unknown>,
): Mode | undefined => {
  const mode = collaborationMode(params)?.mode;
  if (typeof mode !== "string") return undefined;
  return mode === "plan" ? "plan" : "default";
};

// Spelling differences such as a trailing slash do not change the directory; symlinks are not resolved, since that needs the file system.
const isSameDirectory = (a: string, b: string) => resolve(a) === resolve(b);

const collaborationMode = (params: Record<string, unknown>) =>
  isObject(params.collaborationMode) ? params.collaborationMode : undefined;

const REFUSAL_MESSAGES = {
  missing_thread: "the request needs a threadId",
  codex_model: "a Claude thread cannot switch to a Codex model",
  model_change: "changing the model of a Claude thread is not supported yet",
  directory_change:
    "changing the working directory of a Claude thread is not supported yet",
  directory_unknown: "the working directory of this thread is unknown",
  text_only: "Claude threads accept text input only",
  duplicate_message: "this message was already delivered to the Claude thread",
  no_running_turn: "no running Claude turn matches turnId",
  bridge_closing: "the bridge is shutting down",
  thread_not_saved: "the Claude thread could not be saved",
  message_not_saved:
    "the message id could not be saved, so the message was not run to avoid running it twice",
  thread_busy: "the Claude thread cannot start a turn",
  unsupported_request: "this request is not supported on a Claude thread yet",
} as const;
