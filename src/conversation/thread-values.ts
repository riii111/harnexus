import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Result } from "better-result";
import { type EffortRule, isClaudeEffort } from "../infra/claude/models.ts";
import type { CloudLink, ThreadStore } from "../infra/thread-store.ts";
import type { Mode, Thread } from "./thread-request.ts";
import type { ErrorTag } from "./turn-runtime.ts";

export type ThreadValues = ReturnType<typeof createThreadValues>;

// What the app gave a side chat that may run on Claude: its own instructions, and the main conversation as reference text.
export type SideChatContext = {
  instructions: string | null;
  reference: string | null;
};

export type ThreadValueEvent =
  | { event: "claude_turn"; step: "model_changed" }
  | { event: "claude_turn"; step: "session_picked"; thread: string }
  | { event: "claude_turn"; step: "effort_changed"; effort: EffortLevel }
  | { event: "claude_turn"; step: "effort_unsupported" }
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
  | ErrorTag<ReturnType<ThreadStore["setModel"]>>
  | ErrorTag<ReturnType<ThreadStore["setEffort"]>>
  | "ThreadNotFound"
  | "WriteOutcomeUnknown"
  | "WriteNotStarted"
  | "RunStateNotSaved";

// The model, effort and session id a thread runs with are set here before the store saves them and win over what it holds, so a failed save still applies while the bridge runs.
export const createThreadValues = (
  store: ThreadStore,
  log: (event: ThreadValueEvent) => void,
  effortRule: EffortRule,
) => {
  // Threads created with a Claude model are saved to the store only on their first turn, so a thread never used leaves nothing behind.
  const adopted = new Map<string, Thread>();
  const forkSources = new Map<
    string,
    { sessionId: string; at: string | null }
  >();
  const models = new Map<string, string>();
  const efforts = new Map<string, EffortLevel>();
  // A null session id is one Claude lost.
  const sessionIds = new Map<string, string | null>();
  const picked = new Set<string>();
  const sideChats = new Map<string, SideChatContext>();
  // The server keeps a Claude thread in its default mode, so the mode the app picked is remembered here.
  const modes = new Map<string, Mode>();

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

  const isClaudeThread = (threadId: unknown) =>
    typeof threadId === "string" && threadOf(threadId) !== undefined;

  const effortOf = (threadId: string) => {
    const model = threadOf(threadId)?.model;
    return model === undefined
      ? null
      : effortRule(model, pickedEffortOf(threadId));
  };

  const sessionIdOf = (threadId: string) =>
    sessionIds.has(threadId)
      ? (sessionIds.get(threadId) ?? null)
      : (store.get(threadId)?.sessionId ?? null);

  const adopt = (threadId: string, thread: Thread) => {
    if (store.get(threadId) === undefined) adopted.set(threadId, thread);
  };

  // A source with no conversation yet, or one rewound to its start, leaves the fork to start one of its own; a rewound source's record still runs past where it stands, so the fork is pinned there.
  const adoptFork = (threadId: string, thread: Thread, sourceId: string) => {
    if (store.get(threadId) !== undefined) return;
    adopted.set(threadId, thread);
    const rewind = store.get(sourceId)?.rewind;
    if (rewind !== undefined) {
      if (rewind.at !== null) {
        forkSources.set(threadId, {
          sessionId: rewind.sessionId,
          at: rewind.at,
        });
      }
      return;
    }
    const sourceSession = sessionIdOf(sourceId);
    if (sourceSession !== null) {
      forkSources.set(threadId, { sessionId: sourceSession, at: null });
    }
  };

  // A side chat is ephemeral, so what the app gave it is kept only while the bridge runs.
  const noteSideChat = (threadId: string, context: SideChatContext) => {
    sideChats.set(threadId, context);
  };

  const instructionsOf = (threadId: string) =>
    sideChats.get(threadId)?.instructions ?? null;

  // Claude keeps the reference in its record once it holds a conversation, so it goes with every prompt until then, including one sent again after a turn that failed before Claude took it.
  const referenceOf = (threadId: string) =>
    sessionIdOf(threadId) === null
      ? (sideChats.get(threadId)?.reference ?? null)
      : null;

  // Only a fork Claude never ran is forgotten, so nothing was saved of it.
  const forgetFork = (threadId: string) => {
    adopted.delete(threadId);
    forkSources.delete(threadId);
    modes.delete(threadId);
  };

  const forkSourceOf = (threadId: string) =>
    sessionIdOf(threadId) === null
      ? (forkSources.get(threadId)?.sessionId ?? null)
      : null;

  // Null when the fork takes its source's record as it ends when the fork is made.
  const forkPinOf = (threadId: string) => forkSources.get(threadId)?.at ?? null;

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

  const selectMode = (threadId: string, mode: Mode) => {
    modes.set(threadId, mode);
    return mode;
  };

  // A level only Codex models have, such as minimal or ultra, would leave Claude on some other level, so the thread keeps its own.
  const selectEffort = (threadId: string, effort: string) => {
    if (!isClaudeEffort(effort)) {
      log({ event: "claude_turn", step: "effort_unsupported" });
      return;
    }
    changeEffort(threadId, effort);
  };

  const setSessionId = (threadId: string, sessionId: string | null) => {
    sessionIds.set(threadId, sessionId);
    return logUnsaved(store.setSessionId(threadId, sessionId));
  };

  const logUnsaved = async <T extends Result<unknown, { _tag: StoreTag }>>(
    saving: Promise<T>,
  ) => {
    const saved = await saving;
    if (saved.isErr()) {
      log({
        event: "claude_turn",
        step: "session_not_saved",
        error: saved.error._tag,
      });
    }
    return saved;
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

  const cloudOf = (threadId: string): CloudLink | null =>
    store.get(threadId)?.cloud ?? null;

  // Like a picked conversation, a linked Cloud session applies only once the store holds it, and its first reopen carries the whole history.
  const linkCloud = async (
    threadId: string,
    cloud: CloudLink,
    copySessionId: string,
  ) => {
    const linked = await store.linkCloud(threadId, cloud, copySessionId);
    if (linked.isErr()) return linked;
    sessionIds.set(threadId, copySessionId);
    picked.add(threadId);
    return linked;
  };

  // The copy read last is used even if its save fails, since the earlier copy is removed once a new one is read.
  const setCloudCopy = (
    threadId: string,
    copySessionId: string,
    shown: string | null,
  ) => {
    sessionIds.set(threadId, copySessionId);
    return logUnsaved(store.setCloudCopy(threadId, copySessionId, shown));
  };

  // True once per pick, so only the first reopen after it carries the whole history.
  const consumePick = (threadId: string) => picked.delete(threadId);

  return {
    threadOf,
    isClaudeThread,
    pickedEffortOf,
    effortOf,
    sessionIdOf,
    consumePick,
    rewindOf: (threadId: string) => store.get(threadId)?.rewind,
    adopt,
    adoptFork,
    forgetFork,
    noteSideChat,
    instructionsOf,
    referenceOf,
    forkSourceOf,
    forkPinOf,
    isBound,
    bindSession,
    markRegistered,
    changeModel,
    changeEffort,
    selectMode,
    modeOf: (threadId: string) => modes.get(threadId),
    selectEffort,
    setSessionId,
    cloudOf,
    linkCloud,
    setCloudCopy,
    cloudThreadIds: () => store.cloudThreadIds(),
    cloudOwner: (cloudSessionId: string) => store.cloudOwner(cloudSessionId),
  };
};
