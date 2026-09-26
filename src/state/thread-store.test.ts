import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import {
  createEmptyFile,
  FileRemoveFailed,
  FileSyncFailed,
  FileWriteFailed,
  removeFile,
  writeFileAtomic,
} from "../boundary/fs.ts";
import { openThreadStore } from "./thread-store.ts";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-state-"));
  path = join(dir, "threads.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("openThreadStore", () => {
  test("restores the saved mapping in a new store", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.setSessionId("thread-1", "session-1");
    await store.addReviewer("thread-1", "reviewer-1");
    await store.setModel("thread-1", "claude-opus-5-5");
    await store.addMessageId("thread-1", "message-1");

    const reopened = await openStore();

    expect(reopened.get("thread-1")).toEqual({
      threadId: "thread-1",
      sessionId: "session-1",
      model: "claude-opus-5-5",
      worktree: "/work/tree",
      reviewerThreadIds: ["reviewer-1"],
      messageIds: ["message-1"],
      runState: "idle",
    });
  });

  test("loads a file saved before message ids were kept with none", async () => {
    await writeFile(
      path,
      JSON.stringify({ version: 1, threads: [SAVED_RECORD] }),
    );

    const store = await openStore();

    expect(store.get("thread-1")?.messageIds).toEqual([]);
  });

  test.each([
    { name: "is not valid JSON", content: '{"version":1,"threads":[' },
    {
      name: "has records that do not match the format",
      content: JSON.stringify({
        version: 1,
        threads: [{ ...SAVED_RECORD, reviewerThreadIds: [""] }],
      }),
    },
    {
      name: "has the same thread twice",
      content: JSON.stringify({
        version: 1,
        threads: [SAVED_RECORD, SAVED_RECORD],
      }),
    },
  ])("refuses a file that $name", async ({ content }) => {
    await writeFile(path, content);

    const opened = await openThreadStore(path);

    expect(opened.isErr() && opened.error._tag).toBe("StateFileCorrupt");
  });

  test("loads a thread whose write never finished as outcome unknown", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.register({ ...ENTRY, threadId: "thread-2" });
    const started = deferred();
    void store.runWrite(
      "thread-1",
      async () => {
        started.resolve();
        return new Promise<Result<null, never>>(() => {});
      },
      neverUnknown,
    );
    await started.promise;

    const restarted = await openStore();

    expect(restarted.get("thread-1")?.runState).toBe("outcomeUnknown");
    expect(restarted.get("thread-2")?.runState).toBe("idle");
  });
});

describe("ThreadStore", () => {
  test("rejects registering the same thread twice", async () => {
    const store = await openStore();
    await store.register(ENTRY);

    const again = await store.register(ENTRY);

    expect(again.isErr() && again.error._tag).toBe("ThreadAlreadyRegistered");
  });

  test("reports updates to an unknown thread", async () => {
    const store = await openStore();

    const updated = await store.setSessionId("thread-9", "session-1");

    expect(updated.isErr() && updated.error._tag).toBe("ThreadNotFound");
  });

  test("keeps both of two updates to the same thread made at once", async () => {
    const store = await openStore();
    await store.register(ENTRY);

    const [session, reviewer] = await Promise.all([
      store.setSessionId("thread-1", "session-1"),
      store.addReviewer("thread-1", "reviewer-1"),
    ]);

    expect(session.isOk() && session.value.sessionId).toBe("session-1");
    expect(reviewer.isOk() && reviewer.value).toMatchObject(BOTH_UPDATES);
    expect(store.get("thread-1")).toMatchObject(BOTH_UPDATES);
    expect((await openStore()).get("thread-1")).toMatchObject(BOTH_UPDATES);
  });

  test("keeps each reviewer once", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.addReviewer("thread-1", "reviewer-1");
    await store.addReviewer("thread-1", "reviewer-1");

    expect(store.get("thread-1")?.reviewerThreadIds).toEqual(["reviewer-1"]);
  });

  test("names the one worker a reviewer belongs to", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.register({ ...ENTRY, threadId: "thread-2" });
    await store.addReviewer("thread-1", "reviewer-1");
    await store.addReviewer("thread-2", "reviewer-2");

    expect(store.reviewerOwner("reviewer-1")).toBe("thread-1");
    expect(store.reviewerOwner("reviewer-2")).toBe("thread-2");
    expect(store.reviewerOwner("thread-1")).toBeUndefined();
  });

  test("traces a reviewer to its worker while it is being saved and refuses it to another", async () => {
    const gated = gatedWrite();
    const store = await openStore({ writeState: gated.write });
    await store.register(ENTRY);
    await store.register({ ...ENTRY, threadId: "thread-2" });
    const held = gated.hold();
    const first = store.addReviewer("thread-1", "reviewer-1");
    await held.entered;

    expect(store.reviewerOwner("reviewer-1")).toBe("thread-1");
    const second = store.addReviewer("thread-2", "reviewer-1");
    held.release();

    const [added, refused] = await Promise.all([first, second]);
    expect(added.isOk() && added.value.reviewerThreadIds).toEqual([
      "reviewer-1",
    ]);
    expect(refused.isErr() && refused.error._tag).toBe("ReviewerTaken");
    expect(store.reviewerOwner("reviewer-1")).toBe("thread-1");
  });

  test("keeps a reviewer whose save failed traced to its worker and refuses it to another", async () => {
    let failWrites = false;
    const store = await openStore({
      writeState: (target, content) =>
        failWrites ? failingWrite(target) : writeFileAtomic(target, content),
    });
    await store.register(ENTRY);
    await store.register({ ...ENTRY, threadId: "thread-2" });
    failWrites = true;

    const added = await store.addReviewer("thread-1", "reviewer-1");
    const other = await store.addReviewer("thread-2", "reviewer-1");

    expect(added.isErr() && added.error._tag).toBe("StatePersistFailed");
    expect(other.isErr() && other.error._tag).toBe("ReviewerTaken");
    expect(store.get("thread-1")?.reviewerThreadIds).toEqual([]);
    expect(store.reviewerOwner("reviewer-1")).toBe("thread-1");
  });

  test("releases the claim on a Claude thread it refused as a reviewer", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.register({ ...ENTRY, threadId: "thread-2" });

    const added = await store.addReviewer("thread-2", "thread-1");

    expect(added.isErr() && added.error._tag).toBe("ReviewerTaken");
    expect(store.reviewerOwner("thread-1")).toBeUndefined();
  });

  test.each([
    { name: "another worker's reviewer", reviewer: "reviewer-1" },
    { name: "a Claude thread", reviewer: "thread-1" },
  ])("refuses to add $name as a reviewer and keeps it unchanged", async ({
    reviewer,
  }) => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.register({ ...ENTRY, threadId: "thread-2" });
    const first = await store.addReviewer("thread-1", "reviewer-1");
    expect(first.isOk() && first.value.reviewerThreadIds).toEqual([
      "reviewer-1",
    ]);

    const added = await store.addReviewer("thread-2", reviewer);

    expect(added.isErr() && added.error._tag).toBe("ReviewerTaken");
    expect(store.get("thread-2")?.reviewerThreadIds).toEqual([]);
    expect(store.reviewerOwner("reviewer-1")).toBe("thread-1");
  });

  test("keeps each message id once and only the latest 64", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    for (let index = 0; index < 70; index += 1) {
      await store.addMessageId("thread-1", `message-${index}`);
    }
    await store.addMessageId("thread-1", "message-69");

    const ids = store.get("thread-1")?.messageIds ?? [];

    expect(ids).toHaveLength(64);
    expect(ids[0]).toBe("message-6");
    expect(ids.at(-1)).toBe("message-69");
  });

  test("keeps the previous state when a write fails before the rename", async () => {
    const good = await openStore();
    await good.register(ENTRY);
    const store = await openStore({ writeState: failingWrite });

    const updated = await store.setSessionId("thread-1", "session-1");

    expect(updated.isErr() && updated.error._tag).toBe("StatePersistFailed");
    expect(store.get("thread-1")?.sessionId).toBeNull();
    expect((await openStore()).get("thread-1")?.sessionId).toBeNull();
  });

  test("follows the file and stops saving when the rename is not confirmed", async () => {
    const good = await openStore();
    await good.register(ENTRY);
    const store = await openStore({ writeState: writeThenFailSync });

    const updated = await store.setSessionId("thread-1", "session-1");
    const later = await store.setModel("thread-1", "claude-opus-5-5");

    expect(updated.isErr() && updated.error._tag).toBe("StatePersistFailed");
    expect(store.get("thread-1")?.sessionId).toBe("session-1");
    expect(later.isErr() && later.error._tag).toBe("StateStoreHalted");
    expect((await openStore()).get("thread-1")).toMatchObject({
      sessionId: "session-1",
      model: "claude-sonnet-5",
    });
  });

  test("rejects an empty session id and keeps the saved one", async () => {
    const store = await openStore();
    await store.register(ENTRY);

    const updated = await store.setSessionId("thread-1", "");

    expect(updated.isErr() && updated.error._tag).toBe("InvalidThreadRecord");
    expect((await openStore()).get("thread-1")?.sessionId).toBeNull();
  });

  test("rejects registering a thread with an empty model", async () => {
    const store = await openStore();

    const registered = await store.register({ ...ENTRY, model: "" });

    expect(registered.isErr() && registered.error._tag).toBe(
      "InvalidThreadRecord",
    );
    expect((await openStore()).get("thread-1")).toBeUndefined();
  });

  test("never stores fields outside the record", async () => {
    const store = await openStore();
    await store.register({ ...ENTRY, prompt: "secret text" } as typeof ENTRY);

    expect(await readFile(path, "utf8")).not.toContain("secret text");
  });
});

describe("ThreadStore.runWrite", () => {
  test("runs writes to the same thread one at a time", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    const events: string[] = [];
    const started = deferred();
    const blocker = deferred();

    const first = store.runWrite(
      "thread-1",
      async () => {
        events.push("first:start");
        started.resolve();
        await blocker.promise;
        events.push("first:end");
        return Result.ok(1);
      },
      neverUnknown,
    );
    const second = store.runWrite(
      "thread-1",
      async () => {
        events.push("second:start");
        return Result.ok(2);
      },
      neverUnknown,
    );
    await started.promise;
    expect(events).toEqual(["first:start"]);
    expect(store.get("thread-1")?.runState).toBe("running");

    blocker.resolve();
    const results = await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(results.map((result) => result.isOk() && result.value)).toEqual([
      1, 2,
    ]);
    expect(store.get("thread-1")?.runState).toBe("idle");
  });

  test("runs writes to different threads concurrently", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.register({ ...ENTRY, threadId: "thread-2" });
    const blocker = deferred();

    const first = store.runWrite(
      "thread-1",
      async () => {
        await blocker.promise;
        return Result.ok("first");
      },
      neverUnknown,
    );
    const second = await store.runWrite(
      "thread-2",
      async () => Result.ok("second"),
      neverUnknown,
    );

    expect(second.isOk() && second.value).toBe("second");
    expect(store.get("thread-1")?.runState).toBe("running");
    blocker.resolve();
    await first;
  });

  test("finishes a write while another thread's change is being saved", async () => {
    const gated = gatedWrite();
    const store = await openStore({ writeState: gated.write });
    await store.register(ENTRY);
    await store.register({ ...ENTRY, threadId: "thread-2" });
    const started = deferred();
    const blocker = deferred();
    const first = store.runWrite(
      "thread-1",
      async () => {
        started.resolve();
        await blocker.promise;
        return Result.ok(null);
      },
      neverUnknown,
    );
    await started.promise;
    const held = gated.hold();
    const session = store.setSessionId("thread-2", "session-2");
    await held.entered;

    blocker.resolve();
    held.release();
    await Promise.all([first, session]);

    expect(store.get("thread-1")?.runState).toBe("idle");
    expect(store.get("thread-2")?.sessionId).toBe("session-2");
    const reopened = await openStore();
    expect(reopened.get("thread-1")?.runState).toBe("idle");
    expect(reopened.get("thread-2")?.sessionId).toBe("session-2");
  });

  test("keeps an update the operation did not wait for", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    let saved: Promise<unknown> = Promise.resolve();

    await store.runWrite(
      "thread-1",
      async () => {
        saved = store.setSessionId("thread-1", "session-1");
        return Result.ok(null);
      },
      neverUnknown,
    );
    await saved;

    expect(store.get("thread-1")).toMatchObject({
      sessionId: "session-1",
      runState: "idle",
    });
  });

  test("treats a rejected operation as an unknown outcome", async () => {
    const store = await openStore();
    await store.register(ENTRY);

    const rejected = store.runWrite(
      "thread-1",
      () => Promise.reject(new Error("boom")),
      neverUnknown,
    );

    await expect(rejected).rejects.toThrow("boom");
    expect(store.get("thread-1")?.runState).toBe("outcomeUnknown");
    await store.resolveOutcomeUnknown("thread-1");
    const retried = await store.runWrite(
      "thread-1",
      async () => Result.ok("sent"),
      neverUnknown,
    );
    expect(retried.isOk() && retried.value).toBe("sent");
  });

  test("stays outcome unknown while the marker cannot be removed", async () => {
    const store = await openStore({ removeMarker: failingRemove });
    await store.register(ENTRY);
    let runs = 0;
    const operation = async () => {
      runs += 1;
      return Result.ok("sent");
    };

    const result = await store.runWrite("thread-1", operation, neverUnknown);
    const resolved = await store.resolveOutcomeUnknown("thread-1");
    const again = await store.runWrite("thread-1", operation, neverUnknown);
    const restarted = await openStore();
    const afterRestart = await restarted.runWrite(
      "thread-1",
      operation,
      neverUnknown,
    );

    expect(result.isErr() && result.error._tag).toBe("RunStateNotSaved");
    expect(resolved.isErr() && resolved.error._tag).toBe("RunStateNotSaved");
    expect(again.isErr() && again.error._tag).toBe("WriteOutcomeUnknown");
    expect(afterRestart.isErr() && afterRestart.error._tag).toBe(
      "WriteOutcomeUnknown",
    );
    expect(runs).toBe(1);
  });

  test("treats a marker removed without a directory sync as finished", async () => {
    const store = await openStore({ removeMarker: removeThenFailSync });
    await store.register(ENTRY);

    const result = await store.runWrite(
      "thread-1",
      async () => Result.ok("sent"),
      neverUnknown,
    );

    expect(result.isOk() && result.value).toBe("sent");
    expect(store.get("thread-1")?.runState).toBe("idle");
    expect((await openStore()).get("thread-1")?.runState).toBe("idle");
  });

  test("returns to idle after a write that failed with a known outcome", async () => {
    const store = await openStore();
    await store.register(ENTRY);

    const result = await store.runWrite(
      "thread-1",
      async () => Result.err(new Rejected({ message: "rejected" })),
      isSendUncertain,
    );

    expect(result.isErr() && result.error._tag).toBe("Rejected");
    expect(store.get("thread-1")?.runState).toBe("idle");
  });

  test("refuses to run again after a write with an unknown outcome", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.runWrite(
      "thread-1",
      async () => Result.err(new SendUncertain({ message: "lost" })),
      isSendUncertain,
    );
    let called = false;

    const retried = await store.runWrite(
      "thread-1",
      async () => {
        called = true;
        return Result.ok(null);
      },
      neverUnknown,
    );

    expect(retried.isErr() && retried.error._tag).toBe("WriteOutcomeUnknown");
    expect(called).toBe(false);
    expect((await openStore()).get("thread-1")?.runState).toBe(
      "outcomeUnknown",
    );
  });

  test("allows writes again once the unknown outcome is resolved", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.runWrite(
      "thread-1",
      async () => Result.err(new SendUncertain({ message: "lost" })),
      isSendUncertain,
    );
    await store.resolveOutcomeUnknown("thread-1");

    const retried = await store.runWrite(
      "thread-1",
      async () => Result.ok("sent"),
      neverUnknown,
    );

    expect(retried.isOk() && retried.value).toBe("sent");
  });

  test.each([
    { name: "cannot be created", createMarker: failingCreate },
    { name: "is created without a sync", createMarker: createThenFailSync },
  ])("does not start a write whose marker $name", async ({ createMarker }) => {
    const store = await openStore({ createMarker });
    await store.register(ENTRY);
    let called = false;

    const result = await store.runWrite(
      "thread-1",
      async () => {
        called = true;
        return Result.ok(null);
      },
      neverUnknown,
    );

    expect(result.isErr() && result.error._tag).toBe("WriteNotStarted");
    expect(called).toBe(false);
    expect(store.get("thread-1")?.runState).toBe("idle");
    expect(await readdir(`${path}.writes`)).toEqual([]);
  });

  test("reports an unconfirmed marker it cannot withdraw and clears it on resolve", async () => {
    let removals = 0;
    const store = await openStore({
      createMarker: createThenFailSync,
      removeMarker: (target) => {
        removals += 1;
        return removals === 1 ? failingRemove(target) : removeFile(target);
      },
    });
    await store.register(ENTRY);
    let called = false;

    const result = await store.runWrite(
      "thread-1",
      async () => {
        called = true;
        return Result.ok(null);
      },
      neverUnknown,
    );
    const stuck = store.get("thread-1")?.runState;
    const afterRestart = (await openStore()).get("thread-1")?.runState;
    const resolved = await store.resolveOutcomeUnknown("thread-1");

    expect(result.isErr() && result.error._tag).toBe("RunStateNotSaved");
    expect(called).toBe(false);
    expect(stuck).toBe("outcomeUnknown");
    expect(afterRestart).toBe("outcomeUnknown");
    expect(resolved.isOk()).toBe(true);
    expect(store.get("thread-1")?.runState).toBe("idle");
    expect(await readdir(`${path}.writes`)).toEqual([]);
  });

  test("keeps updates made while the write was running", async () => {
    const store = await openStore();
    await store.register(ENTRY);

    await store.runWrite(
      "thread-1",
      async () => {
        await store.setSessionId("thread-1", "session-1");
        return Result.ok(null);
      },
      neverUnknown,
    );

    expect(store.get("thread-1")).toMatchObject({
      sessionId: "session-1",
      runState: "idle",
    });
    expect((await openStore()).get("thread-1")?.sessionId).toBe("session-1");
  });

  test("reports a write to an unknown thread without running it", async () => {
    const store = await openStore();
    let called = false;

    const result = await store.runWrite(
      "thread-9",
      async () => {
        called = true;
        return Result.ok(null);
      },
      neverUnknown,
    );

    expect(result.isErr() && result.error._tag).toBe("ThreadNotFound");
    expect(called).toBe(false);
  });
});

class SendUncertain extends TaggedError("SendUncertain")<{
  message: string;
}> {}

class Rejected extends TaggedError("Rejected")<{ message: string }> {}

const isSendUncertain = (error: SendUncertain | Rejected) =>
  error._tag === "SendUncertain";

const neverUnknown = () => false;

const ENTRY = {
  threadId: "thread-1",
  model: "claude-sonnet-5",
  worktree: "/work/tree",
};

const BOTH_UPDATES = {
  sessionId: "session-1",
  reviewerThreadIds: ["reviewer-1"],
};

const SAVED_RECORD = {
  ...ENTRY,
  sessionId: null,
  reviewerThreadIds: [],
};

const openStore = async (files: Parameters<typeof openThreadStore>[1] = {}) => {
  const opened = await openThreadStore(path, files);
  if (opened.isErr()) return expect.unreachable(opened.error.message);
  return opened.value;
};

const failingWrite = async (target: string) =>
  Result.err(
    new FileWriteFailed({
      path: target,
      cause: new Error("disk full"),
      message: `cannot write ${target}`,
    }),
  );

const writeThenFailSync = async (target: string, content: string) => {
  const written = await writeFileAtomic(target, content);
  if (written.isErr()) return written;
  return Result.err(syncFailed(target));
};

const failingCreate = async (target: string) =>
  Result.err(
    new FileWriteFailed({
      path: target,
      cause: new Error("disk full"),
      message: `cannot create ${target}`,
    }),
  );

const createThenFailSync = async (target: string) => {
  const created = await createEmptyFile(target);
  if (created.isErr()) return created;
  return Result.err(syncFailed(target));
};

const failingRemove = async (target: string) =>
  Result.err(
    new FileRemoveFailed({
      path: target,
      cause: new Error("permission denied"),
      message: `cannot remove ${target}`,
    }),
  );

const removeThenFailSync = async (target: string) => {
  const removed = await removeFile(target);
  if (removed.isErr()) return removed;
  return Result.err(syncFailed(target));
};

const syncFailed = (target: string) =>
  new FileSyncFailed({
    path: target,
    cause: new Error("fsync failed"),
    message: `changed ${target} but cannot sync its directory`,
  });

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Holds the next file write until released, to line up a write with work on another thread.
const gatedWrite = () => {
  let gate: { entered: () => void; release: Promise<void> } | null = null;
  const write = async (target: string, content: string) => {
    const current = gate;
    gate = null;
    if (current !== null) {
      current.entered();
      await current.release;
    }
    return writeFileAtomic(target, content);
  };
  const hold = () => {
    const entered = deferred();
    const release = deferred();
    gate = { entered: entered.resolve, release: release.promise };
    return { entered: entered.promise, release: release.resolve };
  };
  return { write, hold };
};
