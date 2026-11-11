import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Result } from "better-result";

import { type EffortRule, isClaudeEffort } from "../../infra/claude/models.ts";
import type { CloudLink, ThreadStore } from "../../infra/thread-store.ts";
import type { Mode, Thread } from "./thread-request.ts";
import type { ErrorTag, ThreadEnd } from "./turn/turn-runtime.ts";

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

type UnsavedStep =
  | "session_not_saved"
  | "model_not_saved"
  | "effort_not_saved"
  | "archive_not_saved";

// runWrite is generic in the operation's error, so the store's own tags are listed; a new tag there fails to compile here.
export type StoreTag =
  | ErrorTag<ReturnType<ThreadStore["register"]>>
  | ErrorTag<ReturnType<ThreadStore["setSessionId"]>>
  | ErrorTag<ReturnType<ThreadStore["addMessageId"]>>
  | ErrorTag<ReturnType<ThreadStore["setModel"]>>
  | ErrorTag<ReturnType<ThreadStore["setEffort"]>>
  | ErrorTag<ReturnType<ThreadStore["setCloudArchived"]>>
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
  type Overrides = {
    adopted?: Thread;
    forkSource?: { sessionId: string; at: string | null };
    model?: string;
    effort?: EffortLevel;
    // Null means Claude lost the session; absence falls back to the store.
    sessionId?: string | null;
    // Only the first reopen after a pick or Cloud link carries the whole history.
    picked?: boolean;
    sideChat?: SideChatContext;
    mode?: Mode;
  };
  // Overrides apply ahead of the store, including when a save fails.
  const overrides = new Map<string, Overrides>();
  // The latest archive decision per Cloud thread, kept ahead of the store, whose save finishes later and in order.
  const archiveMarks = new Map<
    string,
    { archived: boolean; revision: number }
  >();
  let revisions = 0;
  const valuesOf = (threadId: string) => {
    let values = overrides.get(threadId);
    if (values === undefined) {
      values = {};
      overrides.set(threadId, values);
    }

    return values;
  };

  const prune = (threadId: string) => {
    const values = overrides.get(threadId);
    if (values !== undefined && Object.keys(values).length === 0) {
      overrides.delete(threadId);
    }
  };

  const threadOf = (threadId: string): Thread | undefined => {
    const record = store.get(threadId);
    const thread =
      record === undefined
        ? overrides.get(threadId)?.adopted
        : { model: record.model, cwd: record.worktree };
    const model = overrides.get(threadId)?.model;
    return thread === undefined || model === undefined
      ? thread
      : { ...thread, model };
  };

  const pickedEffortOf = (threadId: string): EffortLevel | null => {
    const effort =
      overrides.get(threadId)?.effort ?? store.get(threadId)?.effort;
    // A saved level that is no Claude level, such as one written by hand, leaves Claude on the user's settings.
    return isClaudeEffort(effort) ? effort : null;
  };

  const isClaudeThread = (threadId: unknown) =>
    typeof threadId === "string" && threadOf(threadId) !== undefined;

  const isSavedClaudeThread = (threadId: string) =>
    store.get(threadId) !== undefined;

  const effortOf = (threadId: string) => {
    const model = threadOf(threadId)?.model;
    return model === undefined
      ? null
      : effortRule(model, pickedEffortOf(threadId));
  };

  const sessionIdOf = (threadId: string) =>
    overrides.get(threadId)?.sessionId !== undefined
      ? (overrides.get(threadId)?.sessionId ?? null)
      : (store.get(threadId)?.sessionId ?? null);

  const adopt = (threadId: string, thread: Thread) => {
    if (store.get(threadId) === undefined) valuesOf(threadId).adopted = thread;
  };

  const adoptFork = (threadId: string, thread: Thread, sourceId: string) => {
    if (store.get(threadId) !== undefined) return;
    valuesOf(threadId).adopted = thread;
    const rewind = store.get(sourceId)?.rewind;
    if (rewind !== undefined) {
      // A rewound source's record still runs past where it stands, so the fork is pinned there; one rewound to its start leaves the fork to start its own conversation.
      if (rewind.at !== null) {
        valuesOf(threadId).forkSource = {
          sessionId: rewind.sessionId,
          at: rewind.at,
        };
      }

      return;
    }

    const sourceSession = sessionIdOf(sourceId);
    if (sourceSession !== null) {
      valuesOf(threadId).forkSource = { sessionId: sourceSession, at: null };
    }
  };

  const noteSideChat = (threadId: string, context: SideChatContext) => {
    valuesOf(threadId).sideChat = context;
  };

  const instructionsOf = (threadId: string) =>
    overrides.get(threadId)?.sideChat?.instructions ?? null;

  const referenceOf = (threadId: string) =>
    // Claude keeps the reference in its record once it holds a conversation, so it goes with every prompt until then.
    sessionIdOf(threadId) === null
      ? (overrides.get(threadId)?.sideChat?.reference ?? null)
      : null;

  const forgetFork = (threadId: string) => {
    const values = overrides.get(threadId);
    if (values === undefined) return;
    delete values.adopted;
    delete values.forkSource;
    delete values.mode;
    prune(threadId);
  };

  const forgetThread = (threadId: string, ended: ThreadEnd) => {
    const record = store.get(threadId);
    // A deleted thread cannot return, so nothing of it is kept.
    if (ended === "deleted") {
      overrides.delete(threadId);
      return;
    }

    // An archived thread can return, so only an override the store already holds goes, and what the app picked or gave the thread stays.
    const values = overrides.get(threadId);
    if (record === undefined || values === undefined) return;
    if (values.model === record.model) delete values.model;
    if (values.effort === record.effort) delete values.effort;
    if (
      values.sessionId !== undefined &&
      values.sessionId === record.sessionId
    ) {
      delete values.sessionId;
    }

    prune(threadId);
  };

  const forkSourceOf = (threadId: string) =>
    sessionIdOf(threadId) === null
      ? (overrides.get(threadId)?.forkSource?.sessionId ?? null)
      : null;

  const forkPinOf = (threadId: string) =>
    overrides.get(threadId)?.forkSource?.at ?? null;

  const isBound = (sessionId: string) => {
    for (const values of overrides.values()) {
      if (values.sessionId === sessionId) return true;
    }

    const owner = store.sessionOwner(sessionId);
    // An id set here but not saved wins over the store's.
    return owner !== undefined && overrides.get(owner)?.sessionId === undefined;
  };

  const bindSession = async (threadId: string, sessionId: string) => {
    if (isBound(sessionId))
      return { bound: false, error: "SessionTaken" as const };
    const saved = await store.bindSession(threadId, sessionId);
    // A picked conversation applies only once the store holds it, so a restart never drops it unannounced; a save whose sync failed already holds it.
    const bound = store.get(threadId)?.sessionId === sessionId;
    if (bound) {
      valuesOf(threadId).sessionId = sessionId;
      valuesOf(threadId).picked = true;
      log({
        event: "claude_turn",
        step: "session_picked",
        thread: threadId.slice(0, 8),
      });
    }

    return { bound, error: saved.isErr() ? saved.error._tag : null };
  };

  const markRegistered = (threadId: string) => {
    const values = overrides.get(threadId);
    if (values !== undefined) delete values.adopted;
    // The registration carried the model and effort from before, so one picked meanwhile is saved now.
    const picked = overrides.get(threadId)?.model;
    if (picked !== undefined && picked !== store.get(threadId)?.model) {
      saveModel(threadId, picked);
    }

    const effort = overrides.get(threadId)?.effort;
    if (effort !== undefined && effort !== store.get(threadId)?.effort) {
      saveEffort(threadId, effort);
    }

    prune(threadId);
  };

  const changeModel = (threadId: string, model: string) => {
    const thread = threadOf(threadId);
    if (thread === undefined || thread.model === model) return;
    valuesOf(threadId).model = model;
    log({ event: "claude_turn", step: "model_changed" });
    // A thread not yet registered saves this model when its first turn registers it.
    if (store.get(threadId) !== undefined) saveModel(threadId, model);
  };

  const changeEffort = (threadId: string, effort: EffortLevel) => {
    if (pickedEffortOf(threadId) === effort) return;
    valuesOf(threadId).effort = effort;
    log({ event: "claude_turn", step: "effort_changed", effort });
    // A thread not yet registered, such as a Codex thread a turn/start switches to Claude, saves this effort when that turn registers it.
    if (store.get(threadId) !== undefined) saveEffort(threadId, effort);
  };

  const selectMode = (threadId: string, mode: Mode) => {
    valuesOf(threadId).mode = mode;
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
    valuesOf(threadId).sessionId = sessionId;
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
    valuesOf(threadId).sessionId = copySessionId;
    valuesOf(threadId).picked = true;
    return linked;
  };

  const setCloudCopy = (
    threadId: string,
    copySessionId: string,
    shown: string | null,
  ) => {
    // The earlier copy is removed once a new one is read, so the new one is used even if its save fails.
    valuesOf(threadId).sessionId = copySessionId;
    return logUnsaved(
      "session_not_saved",
      store.setCloudCopy(threadId, copySessionId, shown),
    );
  };

  const unlinkCloud = (threadId: string) => {
    archiveMarks.delete(threadId);
    const values = overrides.get(threadId);
    if (values !== undefined) delete values.sessionId;
    prune(threadId);
    return logUnsaved("session_not_saved", store.unlinkCloud(threadId));
  };

  const isCloudArchived = (threadId: string) =>
    archiveMarks.get(threadId)?.archived ??
    store.get(threadId)?.archived === true;

  const setCloudArchived = async (threadId: string, archived: boolean) => {
    if (cloudOf(threadId) === null) return;
    revisions += 1;
    archiveMarks.set(threadId, { archived, revision: revisions });
    await logUnsaved(
      "archive_not_saved",
      store.setCloudArchived(threadId, archived),
    );
  };

  const cloudThreadsWhere = (archived: boolean) =>
    [...store.cloudThreadIds(), ...store.archivedCloudThreadIds()].filter(
      (threadId) => isCloudArchived(threadId) === archived,
    );

  const consumePick = (threadId: string) => {
    const values = overrides.get(threadId);
    if (values?.picked !== true) return false;
    delete values.picked;
    prune(threadId);
    return true;
  };

  return {
    threadOf,
    isClaudeThread,
    isSavedClaudeThread,
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
    modeOf: (threadId: string) => overrides.get(threadId)?.mode,
    selectEffort,
    setSessionId,
    cloudOf,
    linkCloud,
    unlinkCloud,
    setCloudCopy,
    cloudThreadIds: () => cloudThreadsWhere(false),
    archivedCloudThreadIds: () => cloudThreadsWhere(true),
    isCloudArchived,
    archiveRevisionOf: (threadId: string) =>
      archiveMarks.get(threadId)?.revision ?? 0,
    setCloudArchived,
    cloudOwner: (cloudSessionId: string) => store.cloudOwner(cloudSessionId),
  };
};
