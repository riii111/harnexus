import { Result, TaggedError } from "better-result";
import {
  type FileSyncFailed,
  type FileWriteFailed,
  readTextFileIfExists,
  writeFileAtomic,
} from "../boundary/fs.ts";
import { type JsonParseFailed, parseJson } from "../boundary/json.ts";
import { createSerialQueue } from "./serial-queue.ts";

// Only identifiers and states are kept, so the file never holds conversation text.
type ThreadRecord = {
  readonly threadId: string;
  readonly sessionId: string | null;
  readonly model: string;
  readonly worktree: string;
  readonly reviewerThreadIds: readonly string[];
  readonly runState: RunState;
};

type RunState = "idle" | "running" | "outcomeUnknown";

class ThreadNotFound extends TaggedError("ThreadNotFound")<{
  threadId: string;
  message: string;
}> {}

class ThreadAlreadyRegistered extends TaggedError("ThreadAlreadyRegistered")<{
  threadId: string;
  message: string;
}> {}

class WriteOutcomeUnknown extends TaggedError("WriteOutcomeUnknown")<{
  threadId: string;
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

class RunStateNotSaved extends TaggedError("RunStateNotSaved")<{
  threadId: string;
  cause: StatePersistFailed | StateStoreHalted;
  message: string;
}> {}

class StateFileCorrupt extends TaggedError("StateFileCorrupt")<{
  path: string;
  cause?: JsonParseFailed;
  message: string;
}> {}

type WriteFile = (
  path: string,
  content: string,
) => Promise<Result<void, FileWriteFailed | FileSyncFailed>>;

// A thread that was running when the previous process stopped may have sent its write, so it is loaded as outcome unknown.
export const openThreadStore = (
  path: string,
  write: WriteFile = writeFileAtomic,
) =>
  Result.gen(async function* () {
    const text = yield* Result.await(readTextFileIfExists(path));
    const loaded = text === null ? [] : yield* parseStateFile(path, text);
    const records = loaded.map((record) =>
      record.runState === "running"
        ? { ...record, runState: "outcomeUnknown" as const }
        : record,
    );
    return Result.ok(createThreadStore(path, records, write));
  });

const createThreadStore = (
  path: string,
  initial: readonly ThreadRecord[],
  write: WriteFile,
) => {
  let records: ReadonlyMap<string, ThreadRecord> = new Map(
    initial.map((record) => [record.threadId, record]),
  );
  let halted = false;
  const threadQueue = createSerialQueue();
  const fileQueue = createSerialQueue();

  const save = async (
    next: ReadonlyMap<string, ThreadRecord>,
  ): Promise<Result<void, StatePersistFailed | StateStoreHalted>> => {
    if (halted) {
      return Result.err(
        new StateStoreHalted({
          path,
          message: `saving to ${path} stopped after an unconfirmed write; restart to reload it`,
        }),
      );
    }
    const written = await write(path, serializeState(next));
    if (written.isOk()) return Result.ok();
    // The file already holds next, so memory follows it; later saves stop because what survives a crash is unknown until the file is reloaded.
    if (written.error._tag === "FileSyncFailed") {
      records = next;
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

  // Every change to records happens inside the file queue, so a snapshot being written is never overtaken by another change.
  // The change is kept in memory only after the file holds it, so a write that fails before the rename leaves both unchanged.
  const persistThenCommit = <E>(
    change: (
      current: ReadonlyMap<string, ThreadRecord>,
    ) => Result<ThreadRecord, E>,
  ) =>
    fileQueue.run(path, async () => {
      const changed = change(records);
      if (changed.isErr()) return Result.err(changed.error);
      const threadId = changed.value.threadId;
      if (!isThreadRecord(changed.value)) {
        return Result.err(
          new InvalidThreadRecord({
            threadId,
            message: "thread identifiers, model and worktree must not be empty",
          }),
        );
      }
      const next = new Map(records).set(threadId, changed.value);
      const saved = await save(next);
      if (saved.isErr()) return Result.err(saved.error);
      records = next;
      return Result.ok(changed.value);
    });

  // An unsaved finish leaves "running" in the file, which reloads as outcome unknown, so memory is set the same way to refuse a repeat before restart.
  const finishWrite = (threadId: string, runState: RunState) =>
    fileQueue.run(path, async () => {
      records = withRunState(records, threadId, runState);
      const saved = await save(records);
      if (saved.isErr()) {
        records = withRunState(records, threadId, "outcomeUnknown");
      }
      return saved;
    });

  const update = (
    threadId: string,
    change: (record: ThreadRecord) => ThreadRecord,
  ) =>
    persistThenCommit((current) => {
      const record = current.get(threadId);
      return record === undefined
        ? Result.err(notFound(threadId))
        : Result.ok(change(record));
    });

  return {
    get: (threadId: string) => records.get(threadId),

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
              runState: "idle" as const,
            }),
      ),

    setSession: (threadId: string, sessionId: string) =>
      update(threadId, (record) => ({ ...record, sessionId })),

    setModel: (threadId: string, model: string) =>
      update(threadId, (record) => ({ ...record, model })),

    addReviewer: (threadId: string, reviewerThreadId: string) =>
      update(threadId, (record) =>
        record.reviewerThreadIds.includes(reviewerThreadId)
          ? record
          : {
              ...record,
              reviewerThreadIds: [
                ...record.reviewerThreadIds,
                reviewerThreadId,
              ],
            },
      ),

    // Clearing the unknown state is left to an explicit user action, because re-running could duplicate a write that already landed.
    resolveOutcomeUnknown: (threadId: string) =>
      update(threadId, (record) =>
        record.runState === "outcomeUnknown"
          ? { ...record, runState: "idle" }
          : record,
      ),

    runWrite: <T, E>(
      threadId: string,
      operation: (record: ThreadRecord) => Promise<Result<T, E>>,
      isOutcomeUnknown: (error: E) => boolean,
    ) =>
      threadQueue.run(threadId, async () => {
        const started = await persistThenCommit((current) =>
          startWrite(current.get(threadId), threadId),
        );
        if (started.isErr()) return Result.err(started.error);
        let finished = false;
        try {
          const result = await operation(started.value);
          const runState: RunState =
            result.isOk() || !isOutcomeUnknown(result.error)
              ? "idle"
              : "outcomeUnknown";
          const saved = await finishWrite(threadId, runState);
          finished = true;
          if (saved.isErr()) {
            return Result.err(
              new RunStateNotSaved({
                threadId,
                cause: saved.error,
                message: `the write on thread ${threadId} finished but its state was not saved, so it is left as outcome unknown`,
              }),
            );
          }
          return result;
        } finally {
          // A rejected operation may have sent its write, so the thread is left as outcome unknown before the rejection propagates.
          if (!finished) await finishWrite(threadId, "outcomeUnknown");
        }
      }),
  };
};

const withRunState = (
  records: ReadonlyMap<string, ThreadRecord>,
  threadId: string,
  runState: RunState,
) => {
  const record = records.get(threadId);
  return record === undefined
    ? records
    : new Map(records).set(threadId, { ...record, runState });
};

// "running" is refused as well: the queue never overlaps writes, so it can only remain from an operation that did not finish.
const startWrite = (
  record: ThreadRecord | undefined,
  threadId: string,
): Result<ThreadRecord, ThreadNotFound | WriteOutcomeUnknown> => {
  if (record === undefined) return Result.err(notFound(threadId));
  if (record.runState !== "idle") {
    return Result.err(
      new WriteOutcomeUnknown({
        threadId,
        message: `the previous write on thread ${threadId} has an unknown outcome`,
      }),
    );
  }
  return Result.ok({ ...record, runState: "running" as const });
};

const notFound = (threadId: string) =>
  new ThreadNotFound({
    threadId,
    message: `thread ${threadId} is not registered`,
  });

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
      const records = readState(value);
      return records === null
        ? Result.err(
            new StateFileCorrupt({
              path,
              message: `${path} does not match the thread state format`,
            }),
          )
        : Result.ok(records);
    });

const serializeState = (records: ReadonlyMap<string, ThreadRecord>) =>
  `${JSON.stringify(
    {
      version: STATE_VERSION,
      threads: [...records.values()].map(pickRecordFields),
    },
    null,
    2,
  )}\n`;

const readState = (value: unknown): ThreadRecord[] | null => {
  if (!isObject(value) || value.version !== STATE_VERSION) return null;
  const threads = value.threads;
  if (!Array.isArray(threads) || !threads.every(isThreadRecord)) return null;
  const ids = new Set(threads.map((record) => record.threadId));
  return ids.size === threads.length ? threads.map(pickRecordFields) : null;
};

const pickRecordFields = (record: ThreadRecord): ThreadRecord => ({
  threadId: record.threadId,
  sessionId: record.sessionId,
  model: record.model,
  worktree: record.worktree,
  reviewerThreadIds: [...record.reviewerThreadIds],
  runState: record.runState,
});

const isThreadRecord = (value: unknown): value is ThreadRecord =>
  isObject(value) &&
  isNonEmptyString(value.threadId) &&
  (value.sessionId === null || isNonEmptyString(value.sessionId)) &&
  isNonEmptyString(value.model) &&
  isNonEmptyString(value.worktree) &&
  Array.isArray(value.reviewerThreadIds) &&
  value.reviewerThreadIds.every(isNonEmptyString) &&
  RUN_STATES.some((state) => state === value.runState);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

const STATE_VERSION = 1;

const RUN_STATES: readonly RunState[] = ["idle", "running", "outcomeUnknown"];
