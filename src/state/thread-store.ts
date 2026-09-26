import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import {
  createEmptyFile,
  type FileRemoveFailed,
  type FileSyncFailed,
  type FileWriteFailed,
  listFileNames,
  prepareDirectory,
  readTextFileIfExists,
  removeFile,
  writeFileAtomic,
} from "../boundary/fs.ts";
import { parseJson } from "../boundary/json.ts";
import { isObject } from "../shared/object.ts";
import { createSerialQueue } from "./serial-queue.ts";

// Only identifiers are kept, so the file never holds conversation text.
type ThreadMapping = {
  readonly threadId: string;
  readonly sessionId: string | null;
  readonly model: string;
  readonly worktree: string;
  readonly reviewerThreadIds: readonly string[];
  // The app's clientUserMessageId of the latest turns, so a message delivered again after a reconnect or restart is not run twice.
  readonly messageIds: readonly string[];
};

export type ThreadRecord = ThreadMapping & { readonly runState: RunState };

type RunState = "idle" | "running" | "outcomeUnknown";

type StoreFiles = {
  writeState: (
    path: string,
    content: string,
  ) => Promise<Result<void, FileWriteFailed | FileSyncFailed>>;
  createMarker: (
    path: string,
  ) => Promise<Result<void, FileWriteFailed | FileSyncFailed>>;
  removeMarker: (
    path: string,
  ) => Promise<Result<void, FileRemoveFailed | FileSyncFailed>>;
};

class ThreadNotFound extends TaggedError("ThreadNotFound")<{
  threadId: string;
  message: string;
}> {}

class ThreadAlreadyRegistered extends TaggedError("ThreadAlreadyRegistered")<{
  threadId: string;
  message: string;
}> {}

class ReviewerTaken extends TaggedError("ReviewerTaken")<{
  threadId: string;
  reviewerThreadId: string;
  message: string;
}> {}

class WriteOutcomeUnknown extends TaggedError("WriteOutcomeUnknown")<{
  threadId: string;
  message: string;
}> {}

class WriteNotStarted extends TaggedError("WriteNotStarted")<{
  threadId: string;
  cause: FileWriteFailed | FileSyncFailed;
  message: string;
}> {}

class RunStateNotSaved extends TaggedError("RunStateNotSaved")<{
  threadId: string;
  cause: FileRemoveFailed;
  message: string;
}> {}

class InvalidThreadRecord extends TaggedError("InvalidThreadRecord")<{
  threadId: string;
  message: string;
}> {}

class StatePersistFailed extends TaggedError("StatePersistFailed")<{
  path: string;
  cause: FileWriteFailed | FileSyncFailed;
  message: string;
}> {}

class StateStoreHalted extends TaggedError("StateStoreHalted")<{
  path: string;
  message: string;
}> {}

class StateFileCorrupt extends TaggedError("StateFileCorrupt")<{
  path: string;
  cause?: unknown;
  message: string;
}> {}

export type ThreadStore = ReturnType<typeof createThreadStore>;

// A write is guarded by a marker file that exists from before the operation until its outcome is known, so a restart finds every unfinished write as outcome unknown.
export const openThreadStore = (
  path: string,
  files: Partial<StoreFiles> = {},
) =>
  Result.gen(async function* () {
    const text = yield* Result.await(readTextFileIfExists(path));
    const mappings = text === null ? [] : yield* parseStateFile(path, text);
    const markerDirectory = `${path}.writes`;
    yield* Result.await(prepareDirectory(markerDirectory));
    const markerNames = yield* Result.await(listFileNames(markerDirectory));
    const unknown = markerNames.flatMap(decodeMarkerName);
    return Result.ok(
      createThreadStore(path, markerDirectory, mappings, unknown, {
        writeState: writeFileAtomic,
        createMarker: createEmptyFile,
        removeMarker: removeFile,
        ...files,
      }),
    );
  });

const createThreadStore = (
  path: string,
  markerDirectory: string,
  initial: readonly ThreadMapping[],
  unknownThreadIds: readonly string[],
  files: StoreFiles,
) => {
  let mappings: ReadonlyMap<string, ThreadMapping> = new Map(
    initial.map((mapping) => [mapping.threadId, mapping]),
  );
  // Run states live only in memory and in marker files, so saving a mapping can never overwrite them.
  const runStates = new Map<string, RunState>(
    unknownThreadIds.map((threadId) => [threadId, "outcomeUnknown"]),
  );
  // A reviewer is claimed from the call that adds it, so a reply arriving while it is saved is already traced to its worker; a claim whose save failed stays, as that worker still created the thread.
  const claimedReviewers = new Map<string, string>();
  let halted = false;
  const threadQueue = createSerialQueue();
  const fileQueue = createSerialQueue();

  const markerPath = (threadId: string) =>
    join(markerDirectory, encodeMarkerName(threadId));

  const save = async (
    next: ReadonlyMap<string, ThreadMapping>,
  ): Promise<Result<void, StatePersistFailed | StateStoreHalted>> => {
    if (halted) {
      return Result.err(
        new StateStoreHalted({
          path,
          message: `saving to ${path} stopped after an unconfirmed write; restart to reload it`,
        }),
      );
    }
    const written = await files.writeState(path, serializeState(next));
    if (written.isOk()) return Result.ok();
    // The file already holds next, so memory follows it; later saves stop because what survives a crash is unknown until the file is reloaded.
    if (written.error._tag === "FileSyncFailed") {
      mappings = next;
      halted = true;
    }
    return Result.err(
      new StatePersistFailed({
        path,
        cause: written.error,
        message: `cannot save thread state to ${path}`,
      }),
    );
  };

  // Every change to mappings happens inside the file queue, so a snapshot being written is never overtaken by another change.
  // The change is kept in memory only after the file holds it, so a write that fails before the rename leaves both unchanged.
  const persistThenCommit = <E>(
    change: (
      current: ReadonlyMap<string, ThreadMapping>,
    ) => Result<ThreadMapping, E>,
  ) =>
    fileQueue.run(path, async () => {
      const changed = change(mappings);
      if (changed.isErr()) return Result.err(changed.error);
      const threadId = changed.value.threadId;
      if (!isThreadMapping(changed.value)) {
        return Result.err(
          new InvalidThreadRecord({
            threadId,
            message: "thread identifiers, model and worktree must not be empty",
          }),
        );
      }
      const next = new Map(mappings).set(threadId, changed.value);
      const saved = await save(next);
      if (saved.isErr()) return Result.err(saved.error);
      mappings = next;
      return Result.ok(changed.value);
    });

  const update = (
    threadId: string,
    change: (mapping: ThreadMapping) => ThreadMapping,
  ) =>
    persistThenCommit((current) => {
      const mapping = current.get(threadId);
      return mapping === undefined
        ? Result.err(notFound(threadId))
        : Result.ok(change(mapping));
    });

  // An unlinked marker whose directory sync failed may come back after a crash, which only reloads the thread as outcome unknown, so it counts as removed.
  const clearMarker = async (threadId: string) => {
    const removed = await files.removeMarker(markerPath(threadId));
    if (removed.isErr() && removed.error._tag === "FileRemoveFailed") {
      runStates.set(threadId, "outcomeUnknown");
      return Result.err(
        new RunStateNotSaved({
          threadId,
          cause: removed.error,
          message: `the marker for thread ${threadId} remains, so it is left as outcome unknown`,
        }),
      );
    }
    runStates.delete(threadId);
    return Result.ok();
  };

  const get = (threadId: string): ThreadRecord | undefined => {
    const mapping = mappings.get(threadId);
    return mapping === undefined
      ? undefined
      : { ...mapping, runState: runStates.get(threadId) ?? "idle" };
  };

  return {
    get,

    register: (entry: { threadId: string; model: string; worktree: string }) =>
      persistThenCommit((current) =>
        current.has(entry.threadId)
          ? Result.err(
              new ThreadAlreadyRegistered({
                threadId: entry.threadId,
                message: `thread ${entry.threadId} is already registered`,
              }),
            )
          : Result.ok({
              ...entry,
              sessionId: null,
              reviewerThreadIds: [],
              messageIds: [],
            }),
      ),

    setSessionId: (threadId: string, sessionId: string) =>
      update(threadId, (mapping) => ({ ...mapping, sessionId })),

    setModel: (threadId: string, model: string) =>
      update(threadId, (mapping) => ({ ...mapping, model })),

    // A reviewer answers one worker only, so a reply can be traced back to that worker; a Claude thread is a worker of its own.
    addReviewer: async (threadId: string, reviewerThreadId: string) => {
      const claimed = claimedReviewers.get(reviewerThreadId);
      if (claimed === undefined) {
        claimedReviewers.set(reviewerThreadId, threadId);
      }
      const added = await persistThenCommit<ThreadNotFound | ReviewerTaken>(
        (current) => {
          const mapping = current.get(threadId);
          if (mapping === undefined) return Result.err(notFound(threadId));
          if (mapping.reviewerThreadIds.includes(reviewerThreadId)) {
            return Result.ok(mapping);
          }
          const taken = takenReviewer(
            current,
            claimed,
            threadId,
            reviewerThreadId,
          );
          if (taken !== null) {
            return Result.err(
              new ReviewerTaken({
                threadId,
                reviewerThreadId,
                message: `thread ${reviewerThreadId} is ${taken}`,
              }),
            );
          }
          return Result.ok({
            ...mapping,
            reviewerThreadIds: [...mapping.reviewerThreadIds, reviewerThreadId],
          });
        },
      );
      const refused =
        added.isErr() &&
        (added.error._tag === "ReviewerTaken" ||
          added.error._tag === "ThreadNotFound");
      if (claimed === undefined && (added.isOk() || refused)) {
        claimedReviewers.delete(reviewerThreadId);
      }
      return added;
    },

    reviewerOwner: (reviewerThreadId: string) =>
      ownerIn(mappings, reviewerThreadId) ??
      claimedReviewers.get(reviewerThreadId),

    addMessageId: (threadId: string, messageId: string) =>
      update(threadId, (mapping) =>
        mapping.messageIds.includes(messageId)
          ? mapping
          : {
              ...mapping,
              messageIds: [...mapping.messageIds, messageId].slice(
                -MESSAGE_ID_LIMIT,
              ),
            },
      ),

    // Clearing the unknown state is left to an explicit user action, because re-running could duplicate a write that already landed.
    resolveOutcomeUnknown: (threadId: string) =>
      threadQueue.run(threadId, async () => {
        const record = get(threadId);
        if (record === undefined) return Result.err(notFound(threadId));
        if (record.runState !== "outcomeUnknown") return Result.ok();
        return clearMarker(threadId);
      }),

    runWrite: <T, E>(
      threadId: string,
      operation: (record: ThreadRecord) => Promise<Result<T, E>>,
      isOutcomeUnknown: (error: E) => boolean,
    ) =>
      threadQueue.run(threadId, async () => {
        const record = get(threadId);
        if (record === undefined) return Result.err(notFound(threadId));
        if (record.runState !== "idle") {
          return Result.err(
            new WriteOutcomeUnknown({
              threadId,
              message: `the previous write on thread ${threadId} has an unknown outcome`,
            }),
          );
        }
        const marked = await files.createMarker(markerPath(threadId));
        if (marked.isErr()) {
          // A marker that exists without a confirmed sync is withdrawn, since the operation never ran.
          if (marked.error._tag === "FileSyncFailed") {
            const cleared = await clearMarker(threadId);
            if (cleared.isErr()) return Result.err(cleared.error);
          }
          return Result.err(
            new WriteNotStarted({
              threadId,
              cause: marked.error,
              message: `cannot mark thread ${threadId} as running`,
            }),
          );
        }
        runStates.set(threadId, "running");
        let outcomeKnown = false;
        try {
          const result = await operation({ ...record, runState: "running" });
          if (result.isErr() && isOutcomeUnknown(result.error)) return result;
          outcomeKnown = true;
          const cleared = await clearMarker(threadId);
          return cleared.isErr() ? Result.err(cleared.error) : result;
        } finally {
          // A rejected operation may have sent its write, so the marker stays and the thread is left as outcome unknown.
          if (!outcomeKnown) runStates.set(threadId, "outcomeUnknown");
        }
      }),
  };
};

const takenReviewer = (
  mappings: ReadonlyMap<string, ThreadMapping>,
  claimedBy: string | undefined,
  threadId: string,
  reviewerThreadId: string,
) => {
  if (mappings.has(reviewerThreadId)) return "a Claude thread";
  const owner = ownerIn(mappings, reviewerThreadId) ?? claimedBy;
  return owner === undefined || owner === threadId
    ? null
    : "another thread's reviewer";
};

const ownerIn = (
  mappings: ReadonlyMap<string, ThreadMapping>,
  reviewerThreadId: string,
) => {
  for (const mapping of mappings.values()) {
    if (mapping.reviewerThreadIds.includes(reviewerThreadId)) {
      return mapping.threadId;
    }
  }
  return undefined;
};

const notFound = (threadId: string) =>
  new ThreadNotFound({
    threadId,
    message: `thread ${threadId} is not registered`,
  });

// Thread IDs are hex-encoded so any ID becomes a safe file name, and other files such as leftovers are ignored.
const encodeMarkerName = (threadId: string) =>
  `${Buffer.from(threadId, "utf8").toString("hex")}${MARKER_SUFFIX}`;

const decodeMarkerName = (name: string) => {
  const hex = name.endsWith(MARKER_SUFFIX)
    ? name.slice(0, -MARKER_SUFFIX.length)
    : "";
  return /^(?:[0-9a-f]{2})+$/.test(hex)
    ? [Buffer.from(hex, "hex").toString("utf8")]
    : [];
};

const parseStateFile = (path: string, text: string) =>
  parseJson(text)
    .mapError(
      (cause) =>
        new StateFileCorrupt({
          path,
          cause,
          message: `${path} is not valid JSON`,
        }),
    )
    .andThen((value) => {
      const mappings = readState(value);
      return mappings === null
        ? Result.err(
            new StateFileCorrupt({
              path,
              message: `${path} does not match the thread state format`,
            }),
          )
        : Result.ok(mappings);
    });

const serializeState = (mappings: ReadonlyMap<string, ThreadMapping>) =>
  `${JSON.stringify(
    {
      version: STATE_VERSION,
      threads: [...mappings.values()].map(pickMappingFields),
    },
    null,
    2,
  )}\n`;

const readState = (value: unknown): ThreadMapping[] | null => {
  if (!isObject(value) || value.version !== STATE_VERSION) return null;
  if (!Array.isArray(value.threads)) return null;
  // Files written before message ids were kept have none.
  const threads = value.threads.map((thread) =>
    isObject(thread) && !("messageIds" in thread)
      ? { ...thread, messageIds: [] }
      : thread,
  );
  if (!threads.every(isThreadMapping)) return null;
  const ids = new Set(threads.map((mapping) => mapping.threadId));
  return ids.size === threads.length ? threads.map(pickMappingFields) : null;
};

const pickMappingFields = (mapping: ThreadMapping): ThreadMapping => ({
  threadId: mapping.threadId,
  sessionId: mapping.sessionId,
  model: mapping.model,
  worktree: mapping.worktree,
  reviewerThreadIds: [...mapping.reviewerThreadIds],
  messageIds: [...mapping.messageIds],
});

const isThreadMapping = (value: unknown): value is ThreadMapping =>
  isObject(value) &&
  isNonEmptyString(value.threadId) &&
  (value.sessionId === null || isNonEmptyString(value.sessionId)) &&
  isNonEmptyString(value.model) &&
  isNonEmptyString(value.worktree) &&
  Array.isArray(value.reviewerThreadIds) &&
  value.reviewerThreadIds.every(isNonEmptyString) &&
  Array.isArray(value.messageIds) &&
  value.messageIds.every(isNonEmptyString);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

const STATE_VERSION = 1;

const MARKER_SUFFIX = ".running";

const MESSAGE_ID_LIMIT = 64;
