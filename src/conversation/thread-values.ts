import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Result } from "better-result";
import { type EffortRule, isClaudeEffort } from "../infra/claude/models.ts";
import type { CloudLink, ThreadStore } from "../infra/thread-store.ts";
import type { Mode, Thread } from "./thread-request.ts";
import type { ErrorTag, ThreadEnd } from "./turn-runtime.ts";

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
  | { event: "claude_turn"; step: UnsavedStep; error: StoreTag };

type UnsavedStep = "session_not_saved" | "model_not_saved" | "effort_not_saved";

// runWrite is generic in the operation's error, so the store's own tags are listed; a new tag there fails to compile here.
export type StoreTag =
  | ErrorTag<ReturnType<ThreadStore["register"]>>
  | ErrorTag<ReturnType<ThreadStore["setSessionId"]>>
  | ErrorTag<ReturnType<ThreadStore["addMessageId"]>>
  | ErrorTag<ReturnType<ThreadStore["setModel"]>>
  | ErrorTag<ReturnType<ThreadStore["setEffort"]>>
  | "ThreadNotFound"
  | "PreviousWriteUnsettled"
  | "WriteNotStarted"
  | "RunStateNotSaved";

// The values each Claude thread runs with, layered over what the store saved.
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
  // Set before the store saves them and read ahead of it, so a failed save still applies while the bridge runs.
  const models = new Map<string, string>();
  const efforts = new Map<string, EffortLevel>();
  // A null session id is one Claude lost.
  const sessionIds = new Map<string, string | null>();
  // Only the first reopen after a conversation is picked or a Cloud session linked carries the whole history.
  const picked = new Set<string>();
  // A side chat is ephemeral, so what the app gave it is kept only while the bridge runs.
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

  const pickedEffortOf = (threadId: string): EffortLevel | null => {
    const effort = efforts.get(threadId) ?? store.get(threadId)?.effort;
    // A saved level that is no Claude level, such as one written by hand, leaves Claude on the user's settings.
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

  const adoptFork = (threadId: string, thread: Thread, sourceId: string) => {
    if (store.get(threadId) !== undefined) return;
    adopted.set(threadId, thread);
    const rewind = store.get(sourceId)?.rewind;
    if (rewind !== undefined) {
      // A rewound source's record still runs past where it stands, so the fork is pinned there; one rewound to its start leaves the fork to start its own conversation.
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

  const noteSideChat = (threadId: string, context: SideChatContext) => {
    sideChats.set(threadId, context);
  };

  const instructionsOf = (threadId: string) =>
    sideChats.get(threadId)?.instructions ?? null;

  const referenceOf = (threadId: string) =>
    // Claude keeps the reference in its record once it holds a conversation, so it goes with every prompt until then.
    sessionIdOf(threadId) === null
      ? (sideChats.get(threadId)?.reference ?? null)
      : null;

  const forgetFork = (threadId: string) => {
    adopted.delete(threadId);
    forkSources.delete(threadId);
    modes.delete(threadId);
  };

  const forgetThread = (threadId: string, ended: ThreadEnd) => {
    const record = store.get(threadId);
    // A deleted thread cannot return, so nothing of it is kept.
    if (ended === "deleted") {
      for (const held of [models, efforts, sessionIds, sideChats, modes]) {
        held.delete(threadId);
      }
      picked.delete(threadId);
      forgetFork(threadId);
      return;
    }
    // An archived thread can return, so only an override the store already holds goes, and what the app picked or gave the thread stays.
    if (record === undefined) return;
    if (models.get(threadId) === record.model) models.delete(threadId);
    if (efforts.get(threadId) === record.effort) efforts.delete(threadId);
    if (
      sessionIds.has(threadId) &&
      sessionIds.get(threadId) === record.sessionId
    ) {
      sessionIds.delete(threadId);
    }
  };

  const forkSourceOf = (threadId: string) =>
    sessionIdOf(threadId) === null
      ? (forkSources.get(threadId)?.sessionId ?? null)
      : null;

  const forkPinOf = (threadId: string) => forkSources.get(threadId)?.at ?? null;

  const isBound = (sessionId: string) => {
    for (const id of sessionIds.values()) if (id === sessionId) return true;
    const owner = store.sessionOwner(sessionId);
    // An id set here but not saved wins over the store's.
    return owner !== undefined && !sessionIds.has(owner);
  };

  const bindSession = async (threadId: string, sessionId: string) => {
    if (isBound(sessionId))
      return { bound: false, error: "SessionTaken" as const };
    const saved = await store.bindSession(threadId, sessionId);
    // A picked conversation applies only once the store holds it, so a restart never drops it unannounced; a save whose sync failed already holds it.
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

  const markRegistered = (threadId: string) => {
    adopted.delete(threadId);
    // The registration carried the model and effort from before, so one picked meanwhile is saved now.
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

  const changeEffort = (threadId: string, effort: EffortLevel) => {
    if (pickedEffortOf(threadId) === effort) return;
    efforts.set(threadId, effort);
    log({ event: "claude_turn", step: "effort_changed", effort });
    // A thread not yet registered, such as a Codex thread a turn/start switches to Claude, saves this effort when that turn registers it.
    if (store.get(threadId) !== undefined) saveEffort(threadId, effort);
  };

  const selectMode = (threadId: string, mode: Mode) => {
    modes.set(threadId, mode);
    return mode;
  };

  const selectEffort = (threadId: string, effort: string) => {
    // A level only Codex models have, such as minimal or ultra, would leave Claude on some other level, so the thread keeps its own.
    if (!isClaudeEffort(effort)) {
      log({ event: "claude_turn", step: "effort_unsupported" });
      return;
    }
    changeEffort(threadId, effort);
  };

  const setSessionId = (threadId: string, sessionId: string | null) => {
    sessionIds.set(threadId, sessionId);
    return logUnsaved(
      "session_not_saved",
      store.setSessionId(threadId, sessionId),
    );
  };

  const logUnsaved = async <T extends Result<unknown, { _tag: StoreTag }>>(
    step: UnsavedStep,
    saving: Promise<T>,
  ) => {
    const saved = await saving;
    if (saved.isErr()) {
      log({ event: "claude_turn", step, error: saved.error._tag });
    }
    return saved;
  };

  const saveModel = (threadId: string, model: string) => {
    void logUnsaved("model_not_saved", store.setModel(threadId, model));
  };

  const saveEffort = (threadId: string, effort: EffortLevel) => {
    void logUnsaved("effort_not_saved", store.setEffort(threadId, effort));
  };

  const cloudOf = (threadId: string): CloudLink | null =>
    store.get(threadId)?.cloud ?? null;

  const linkCloud = async (
    threadId: string,
    cloud: CloudLink,
    copySessionId: string,
  ) => {
    const linked = await store.linkCloud(threadId, cloud, copySessionId);
    // Like a picked conversation, a linked Cloud session applies only once the store holds it.
    if (linked.isErr()) return linked;
    sessionIds.set(threadId, copySessionId);
    picked.add(threadId);
    return linked;
  };

  const setCloudCopy = (
    threadId: string,
    copySessionId: string,
    shown: string | null,
  ) => {
    // The earlier copy is removed once a new one is read, so the new one is used even if its save fails.
    sessionIds.set(threadId, copySessionId);
    return logUnsaved(
      "session_not_saved",
      store.setCloudCopy(threadId, copySessionId, shown),
    );
  };

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
    forgetThread,
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
