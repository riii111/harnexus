import { resolve } from "node:path";
import { isClaudeModel } from "../infra/claude/models.ts";
import { isObject } from "../runtime/object.ts";

export type Thread = { model: string; cwd: string };

export type AppRequest = {
  id: string | number;
  params: Record<string, unknown>;
};

export type Refusal = keyof typeof REFUSAL_MESSAGES;

export type Mode = "plan" | "default";

// The app spreads its last collaboration mode into requests while model carries the new choice (App 26.924), so model is read first and the mode only fills in when model is absent.
export const requestedModel = (params: Record<string, unknown>) => {
  if (typeof params.model === "string") return params.model;
  const settings = collaborationMode(params)?.settings;
  return isObject(settings) && typeof settings.model === "string"
    ? settings.model
    : undefined;
};

// Read in the same order as the model, since the spread mode may carry the effort of an earlier choice.
export const requestedEffort = (params: Record<string, unknown>) => {
  if (typeof params.effort === "string") return params.effort;
  const settings = collaborationMode(params)?.settings;
  return isObject(settings) && typeof settings.reasoning_effort === "string"
    ? settings.reasoning_effort
    : undefined;
};

// fallbackCwd is where the server last reported a Codex thread, since a request that switches it to Claude may not carry its directory.
// A thread may move to another Claude model, but Claude keeps running where the thread started, so a new directory is refused.
export const checkThread = (
  params: Record<string, unknown>,
  known: Thread | undefined,
  fallbackCwd: string | undefined,
): { thread: Thread } | { refusal: Refusal } => {
  const model = requestedModel(params) ?? known?.model;
  if (!isClaudeModel(model)) return { refusal: "codex_model" };
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

// A turn checked before another turn saved the thread would otherwise run in the directory that turn saved; a different model is a model change, which the turn applies itself.
export const savedThreadChange = (
  requested: Thread,
  saved: Thread,
): Refusal | null =>
  isSameDirectory(requested.cwd, saved.cwd) ? null : "directory_change";

export const refusalMessage = (refusal: Refusal) => REFUSAL_MESSAGES[refusal];

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
  directory_change:
    "changing the working directory of a Claude thread is not supported",
  directory_unknown: "the working directory of this thread is unknown",
  unsupported_input:
    "Claude threads accept text and images only; send audio and other attachments in a Codex thread",
  image_not_local:
    "Claude can read only images attached from this Mac; save the image as a file, then attach or paste it again",
  image_unreadable:
    "an attached image could not be read, possibly because it was moved or deleted; attach it again",
  image_format:
    "Claude reads PNG, JPEG, GIF and WebP images only; convert the image to one of these formats, then attach it again",
  image_too_large:
    "an attached image is too large for Claude and could not be reduced; crop it or attach a smaller image",
  reply_to_other_worker:
    "this message comes from a reviewer of another Claude thread",
  duplicate_message: "this message was already delivered to the Claude thread",
  no_running_turn: "no running Claude turn matches the turn id",
  steer_not_sent: "the Claude turn ended before the steer reached it",
  nothing_to_compact: "there is no Claude conversation to compact yet",
  compaction_not_steerable:
    "a compaction takes no steers; send it as the next turn",
  command_not_steerable:
    "the bridge answers this turn itself and takes no steers; send it as the next turn",
  approvals_not_steerable:
    "this turn only shows Claude's requests for approval and takes no steers; send it as the next turn",
  too_many_steers:
    "this Claude turn takes no more steers; send it as the next turn",
  bridge_closing: "the bridge is shutting down",
  thread_not_saved: "the Claude thread could not be saved",
  message_not_saved:
    "the message id could not be saved, so the message was not run to avoid running it twice",
  requester_not_saved:
    "the thread that sent this message could not be saved, so Claude could not answer it and the message was not run",
  thread_busy: "the Claude thread cannot start a turn",
  outcome_unknown:
    "the previous Claude turn on this thread stopped before its outcome was known; check what that turn did, such as changed files or messages to other threads, then send a message yourself to continue",
  unsupported_request: "this request is not supported on a Claude thread yet",
  model_mismatch:
    "this thread's first turn asked for another model or effort than the thread that created it expected, or did not say which, so it was not run",
  claude_paused:
    "Claude threads are paused because harnexus was not checked on this Codex CLI version; update harnexus, or unset HARNEXUS_UNVERIFIED_CODEX to run anyway",
} as const;
