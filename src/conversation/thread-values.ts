import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { isClaudeEffort } from "../infra/claude/models.ts";
import type { ThreadStore } from "../infra/thread-store.ts";
import type { Thread } from "./thread-request.ts";
import type { ErrorTag } from "./turn-runtime.ts";

export type ThreadValues = ReturnType<typeof createThreadValues>;

export type ThreadValueEvent =
  | { event: "claude_turn"; step: "model_changed" }
  | { event: "claude_turn"; step: "effort_changed"; effort: EffortLevel }
  | {
      event: "claude_turn";
      step: "session_not_saved" | "model_not_saved" | "effort_not_saved";
      error: StoreTag;
    };

// runWrite is generic in the operation's error, so the store's own tags are listed; a new tag there fails to compile here.
export type StoreTag =
  | ErrorTag<ReturnType<ThreadStore["register"]>>
  | ErrorTag<ReturnType<ThreadStore["setSessionId"]>>
  | ErrorTag<ReturnType<ThreadStore["addMessageId"]>>
  | ErrorTag<ReturnType<ThreadStore["addRequester"]>>
  | ErrorTag<ReturnType<ThreadStore["setModel"]>>
  | ErrorTag<ReturnType<ThreadStore["setEffort"]>>
  | "ThreadNotFound"
  | "WriteOutcomeUnknown"
  | "WriteNotStarted"
  | "RunStateNotSaved";

// The model, effort and session id a thread runs with are set here before the store saves them and win over what it holds, so a failed save still applies while the bridge runs; a null session id is one Claude lost.
export const createThreadValues = (
  store: ThreadStore,
  log: (event: ThreadValueEvent) => void,
) => {
  // Threads created with a Claude model are saved to the store only on their first turn, so a thread never used leaves nothing behind.
  const adopted = new Map<string, Thread>();
  const models = new Map<string, string>();
  const efforts = new Map<string, EffortLevel>();
  const sessionIds = new Map<string, string | null>();

  const threadOf = (threadId: string): Thread | undefined => {
    const record = store.get(threadId);
    const thread =
      record === undefined
        ? adopted.get(threadId)
        : { model: record.model, cwd: record.worktree };
    const model = models.get(threadId);
    return thread === undefined || model === undefined
      ? thread
      : { ...thread, model };
  };

  // A saved level that is no Claude level, such as one written by hand, leaves Claude on the user's settings.
  const pickedEffortOf = (threadId: string): EffortLevel | null => {
    const effort = efforts.get(threadId) ?? store.get(threadId)?.effort;
    return isClaudeEffort(effort) ? effort : null;
  };

  const sessionIdOf = (threadId: string) =>
    sessionIds.has(threadId)
      ? (sessionIds.get(threadId) ?? null)
      : (store.get(threadId)?.sessionId ?? null);

  const adopt = (threadId: string, thread: Thread) => {
    if (store.get(threadId) === undefined) adopted.set(threadId, thread);
  };

  // A model or effort picked while the thread was being registered is saved now, since the registration carried the earlier one.
  const markRegistered = (threadId: string) => {
    adopted.delete(threadId);
    const picked = models.get(threadId);
    if (picked !== undefined && picked !== store.get(threadId)?.model) {
      saveModel(threadId, picked);
    }
    const effort = efforts.get(threadId);
    if (effort !== undefined && effort !== store.get(threadId)?.effort) {
      saveEffort(threadId, effort);
    }
  };

  // A running turn keeps its model; the next turn restarts Claude on the new one and resumes the same conversation.
  const changeModel = (threadId: string, model: string) => {
    const thread = threadOf(threadId);
    if (thread === undefined || thread.model === model) return;
    models.set(threadId, model);
    log({ event: "claude_turn", step: "model_changed" });
    // A thread not yet registered saves this model when its first turn registers it.
    if (store.get(threadId) !== undefined) saveModel(threadId, model);
  };

  // A Codex thread switched to Claude by a turn/start is not known yet, and that turn registers it with this effort.
  const changeEffort = (threadId: string, effort: EffortLevel) => {
    if (pickedEffortOf(threadId) === effort) return;
    efforts.set(threadId, effort);
    log({ event: "claude_turn", step: "effort_changed", effort });
    if (store.get(threadId) !== undefined) saveEffort(threadId, effort);
  };

  const setSessionId = async (threadId: string, sessionId: string | null) => {
    sessionIds.set(threadId, sessionId);
    const saved = await store.setSessionId(threadId, sessionId);
    if (saved.isErr()) {
      log({
        event: "claude_turn",
        step: "session_not_saved",
        error: saved.error._tag,
      });
    }
  };

  const saveModel = (threadId: string, model: string) => {
    void store.setModel(threadId, model).then((saved) => {
      if (saved.isErr()) {
        log({
          event: "claude_turn",
          step: "model_not_saved",
          error: saved.error._tag,
        });
      }
    });
  };

  const saveEffort = (threadId: string, effort: EffortLevel) => {
    void store.setEffort(threadId, effort).then((saved) => {
      if (saved.isErr()) {
        log({
          event: "claude_turn",
          step: "effort_not_saved",
          error: saved.error._tag,
        });
      }
    });
  };

  return {
    threadOf,
    pickedEffortOf,
    sessionIdOf,
    adopt,
    markRegistered,
    changeModel,
    changeEffort,
    setSessionId,
  };
};
