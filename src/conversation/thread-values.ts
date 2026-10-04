import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import {
  type ConnectionTarget,
  sameTarget,
} from "../infra/claude/connection.ts";
import { isClaudeEffort } from "../infra/claude/models.ts";
import type { ThreadStore } from "../infra/thread-store.ts";
import type { Thread } from "./thread-request.ts";
import type { ErrorTag } from "./turn-runtime.ts";

export type ThreadValues = ReturnType<typeof createThreadValues>;

export type ThreadValueEvent =
  | { event: "claude_turn"; step: "model_changed" }
  | { event: "claude_turn"; step: "session_picked"; thread: string }
  | { event: "claude_turn"; step: "effort_changed"; effort: EffortLevel }
  | {
      event: "claude_turn";
      step:
        | "session_not_saved"
        | "model_not_saved"
        | "effort_not_saved"
        | "connection_not_saved";
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
  | ErrorTag<ReturnType<ThreadStore["setConnection"]>>
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
  // A thread forked from a Claude thread, such as a side chat, starts its own conversation from the source's as it stood at the fork.
  const forkSources = new Map<string, string>();
  const models = new Map<string, string>();
  const efforts = new Map<string, EffortLevel>();
  const sessionIds = new Map<string, string | null>();
  // Threads given a picked conversation since the app last opened them, whose history the app does not hold yet.
  const picked = new Set<string>();

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

  const connectionOf = (threadId: string) =>
    store.get(threadId)?.connection ?? null;

  const adopt = (threadId: string, thread: Thread) => {
    if (store.get(threadId) === undefined) adopted.set(threadId, thread);
  };

  // A source with no conversation yet leaves the fork to start one of its own.
  const adoptFork = (threadId: string, thread: Thread, sourceId: string) => {
    if (store.get(threadId) !== undefined) return;
    adopted.set(threadId, thread);
    const sourceSession = sessionIdOf(sourceId);
    if (sourceSession !== null) forkSources.set(threadId, sourceSession);
  };

  // Once the fork has a conversation of its own, it resumes that one.
  const forkSourceOf = (threadId: string) =>
    sessionIdOf(threadId) === null ? (forkSources.get(threadId) ?? null) : null;

  // An id set here but not saved wins over the store's, as in sessionIdOf.
  const isBound = (sessionId: string) => {
    for (const id of sessionIds.values()) if (id === sessionId) return true;
    const owner = store.sessionOwner(sessionId);
    return owner !== undefined && !sessionIds.has(owner);
  };

  // Unlike an id Claude reports, a picked conversation applies only once the store holds it, so a restart never drops it unannounced; a save whose sync failed already holds it.
  const bindSession = async (threadId: string, sessionId: string) => {
    if (isBound(sessionId))
      return { bound: false, error: "SessionTaken" as const };
    const saved = await store.bindSession(threadId, sessionId);
    const bound = store.get(threadId)?.sessionId === sessionId;
    if (bound) {
      sessionIds.set(threadId, sessionId);
      picked.add(threadId);
      log({
        event: "claude_turn",
        step: "session_picked",
        thread: threadId.slice(0, 8),
      });
    }
    return { bound, error: saved.isErr() ? saved.error._tag : null };
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

  // Unlike a session id, a connection applies only once the store holds it, so a restart never resumes a conversation on a connection nobody confirmed; a save whose sync failed already holds it.
  const setConnection = async (
    threadId: string,
    connection: ConnectionTarget | null,
  ) => {
    const saved = await store.setConnection(threadId, connection);
    if (saved.isErr()) {
      log({
        event: "claude_turn",
        step: "connection_not_saved",
        error: saved.error._tag,
      });
    }
    const held = connectionOf(threadId);
    return connection === null || held === null
      ? held === connection
      : sameTarget(held, connection);
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

  // True once per pick, so only the first reopen after it carries the whole history.
  const takePicked = (threadId: string) => picked.delete(threadId);

  return {
    threadOf,
    pickedEffortOf,
    sessionIdOf,
    connectionOf,
    takePicked,
    rewindOf: (threadId: string) => store.get(threadId)?.rewind,
    adopt,
    adoptFork,
    forkSourceOf,
    isBound,
    bindSession,
    markRegistered,
    changeModel,
    changeEffort,
    setSessionId,
    setConnection,
  };
};
