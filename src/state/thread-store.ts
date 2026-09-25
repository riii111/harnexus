import { Result, TaggedError } from "better-result";
import {
  type FileWriteFailed,
  readTextFileIfExists,
  writeFileAtomic,
} from "../boundary/fs.ts";
import { parseJson } from "../boundary/json.ts";
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
  cause: FileWriteFailed;
  message: string;
}> {}

class StateFileCorrupt extends TaggedError("StateFileCorrupt")<{
  path: string;
  message: string;
}> {}

type WriteFile = (
  path: string,
  content: string,
) => Promise<Result<void, FileWriteFailed>>;

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
  const threadQueue = createSerialQueue();
  const fileQueue = createSerialQueue();

  // Every change to records happens inside the file queue, so a snapshot being written is never overtaken by another change.
  // The change is kept in memory only after the file holds it, so a failed write leaves both unchanged.
  const persistThenCommit = <E>(
    change: (
      current: ReadonlyMap<string, ThreadRecord>,
    ) => Result<ThreadRecord, E>,
  ) =>
    fileQueue.run(path, async () => {
      const changed = change(records);
      if (changed.isErr()) return Result.err(changed.error);
      if (!isStorable(changed.value)) {
        return Result.err(
          new InvalidThreadRecord({
            threadId: changed.value.threadId,
            message: "thread identifiers, model and worktree must not be empty",
          }),
        );
      }
      const next = new Map(records).set(changed.value.threadId, changed.value);
      const written = await write(path, serializeState(next));
      if (written.isErr()) {
        return Result.err(
          new StatePersistFailed({
            path,
            cause: written.error,
            message: `cannot save thread state to ${path}`,
          }),
        );
      }
      records = next;
      return Result.ok(changed.value);
    });

  // Used after a write has run: memory must reflect it even if the file lags, and a stale "running" entry reloads as outcome unknown.
  const finishWrite = (threadId: string, runState: RunState) =>
    fileQueue.run(path, async () => {
      const record = records.get(threadId);
      if (record === undefined) return;
      records = new Map(records).set(threadId, { ...record, runState });
      await write(path, serializeState(records));
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
        // A rejected operation may have sent its write, so the thread is left as outcome unknown before the rejection propagates.
        let runState: RunState = "outcomeUnknown";
        try {
          const result = await operation(started.value);
          if (result.isOk() || !isOutcomeUnknown(result.error)) {
            runState = "idle";
          }
          return result;
        } finally {
          await finishWrite(threadId, runState);
        }
      }),
  };
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
      () =>
        new StateFileCorrupt({ path, message: `${path} is not valid JSON` }),
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

// A plain boolean check: the type guard would narrow the failing branch to never, hiding the thread ID for the error.
const isStorable = (record: ThreadRecord) => isThreadRecord(record);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

const STATE_VERSION = 1;

const RUN_STATES: readonly RunState[] = ["idle", "running", "outcomeUnknown"];
