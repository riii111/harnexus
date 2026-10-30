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
} from "../runtime/fs.boundary.ts";
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
    await store.setModel("thread-1", "claude-opus-5-5");
    await store.setEffort("thread-1", "max");
    await store.addMessageId("thread-1", "message-1");

    const reopened = await openStore();

    expect(reopened.get("thread-1")).toEqual({
      threadId: "thread-1",
      sessionId: "session-1",
      model: "claude-opus-5-5",
      effort: "max",
      worktree: "/work/tree",
      messageIds: ["message-1"],
      runState: "idle",
    });
  });

  test("loads a file saved before message ids and efforts were kept with none of them", async () => {
    await writeFile(
      path,
      JSON.stringify({ version: 1, threads: [SAVED_RECORD] }),
    );

    const store = await openStore();

    expect(store.get("thread-1")).toMatchObject({
      messageIds: [],
      effort: null,
    });
  });

  test("loads a file that still lists reviewer and requester threads without them", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        threads: [
          {
            ...SAVED_RECORD,
            reviewerThreadIds: ["reviewer-1"],
            requesterThreadIds: ["worker-1"],
          },
        ],
      }),
    );

    const store = await openStore();

    expect(store.get("thread-1")).toEqual({
      ...ENTRY,
      sessionId: null,
      effort: null,
      messageIds: [],
      runState: "idle",
    });
  });

  test("saves the reviewer key earlier versions require to load the file", async () => {
    const store = await openStore();
    await store.register(ENTRY);

    await store.setModel("thread-1", "claude-opus-5-5");

    expect(JSON.parse(await readFile(path, "utf8")).threads[0]).toMatchObject({
      model: "claude-opus-5-5",
      reviewerThreadIds: [],
    });
  });

  test("registers a thread with the effort it was given", async () => {
    const store = await openStore();

    const registered = await store.register({ ...ENTRY, effort: "high" });

    expect(registered.isOk() && registered.value.effort).toBe("high");
  });

  test.each([
    { name: "is not valid JSON", content: '{"version":1,"threads":[' },
    {
      name: "has records that do not match the format",
      content: JSON.stringify({
        version: 1,
        threads: [{ ...SAVED_RECORD, messageIds: [""] }],
      }),
    },
    {
      name: "has an effort that is not a level name",
      content: JSON.stringify({
        version: 1,
        threads: [{ ...SAVED_RECORD, effort: 3 }],
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

    const [session, model] = await Promise.all([
      store.setSessionId("thread-1", "session-1"),
      store.setModel("thread-1", "claude-opus-5-5"),
    ]);

    expect(session.isOk() && session.value.sessionId).toBe("session-1");
    expect(model.isOk() && model.value).toMatchObject(BOTH_UPDATES);
    expect(store.get("thread-1")).toMatchObject(BOTH_UPDATES);
    expect((await openStore()).get("thread-1")).toMatchObject(BOTH_UPDATES);
  });

  test("keeps each message id once and only the latest 64", async () => {
    const store = await openStore({ writeState: async () => Result.ok() });
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

  test("follows the file when the rename is not confirmed and keeps saving", async () => {
    const good = await openStore();
    await good.register(ENTRY);
    const store = await openStore({ writeState: writeThenFailSyncOnce() });

    const updated = await store.setSessionId("thread-1", "session-1");
    const later = await store.setModel("thread-1", "claude-opus-5-5");

    expect(updated.isErr() && updated.error._tag).toBe("StatePersistFailed");
    expect(later.isOk() && later.value).toMatchObject(BOTH_UPDATES);
    expect((await openStore()).get("thread-1")).toMatchObject(BOTH_UPDATES);
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

describe("ThreadStore Cloud links", () => {
  test("links an empty thread to a Cloud session and restores it in a new store", async () => {
    const store = await openStore();
    await store.register(ENTRY);

    const linked = await store.linkCloud("thread-1", CLOUD, "copy-1");
    const reopened = await openStore();

    expect(linked.isOk()).toBe(true);
    expect(reopened.get("thread-1")).toMatchObject({
      sessionId: "copy-1",
      cloud: CLOUD,
    });
    expect(reopened.cloudOwner("session_01Cloud")).toBe("thread-1");
    expect(reopened.cloudThreadIds()).toEqual(["thread-1"]);
  });

  test("refuses a thread that already holds a conversation", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.setSessionId("thread-1", "session-1");

    const linked = await store.linkCloud("thread-1", CLOUD, "copy-1");

    expect(linked.isErr() && linked.error._tag).toBe("ThreadHasConversation");
    expect(store.get("thread-1")?.cloud).toBeUndefined();
  });

  test("gives a Cloud session to only one thread", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.register({ ...ENTRY, threadId: "thread-2" });

    const [first, second] = await Promise.all([
      store.linkCloud("thread-1", CLOUD, "copy-1"),
      store.linkCloud("thread-2", CLOUD, "copy-2"),
    ]);

    expect(first.isOk()).toBe(true);
    expect(second.isErr() && second.error._tag).toBe("CloudSessionTaken");
    expect(store.get("thread-2")?.sessionId).toBeNull();
  });

  test("replaces the copy and how far the app was shown together", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.linkCloud("thread-1", CLOUD, "copy-1");

    await store.setCloudCopy("thread-1", "copy-2", "record-9");

    expect(store.get("thread-1")).toMatchObject({
      sessionId: "copy-2",
      cloud: { sessionId: "session_01Cloud", shown: "record-9" },
    });
  });

  test("leaves a thread that shows no Cloud session as it is", async () => {
    const store = await openStore();
    await store.register(ENTRY);

    await store.setCloudCopy("thread-1", "copy-2", "record-9");

    expect(store.get("thread-1")?.sessionId).toBeNull();
  });

  test("rejects a saved link without a Cloud session id", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        threads: [{ ...SAVED_RECORD, cloud: { sessionId: "", shown: null } }],
      }),
    );

    const opened = await openThreadStore(path);

    expect(opened.isErr() && opened.error._tag).toBe("StateFileCorrupt");
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
    const started = deferred();
    const blocker = deferred();

    const first = store.runWrite(
      "thread-1",
      async () => {
        started.resolve();
        await blocker.promise;
        return Result.ok("first");
      },
      neverUnknown,
    );
    await started.promise;
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

  test("refuses to run again after a write with an unknown outcome until it is resolved", async () => {
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

    const resolved = await store.resolveOutcomeUnknown("thread-1");
    const resumed = await store.runWrite(
      "thread-1",
      async () => Result.ok("sent"),
      neverUnknown,
    );

    expect(resolved.isOk()).toBe(true);
    expect(resumed.isOk() && resumed.value).toBe("sent");
  });

  test("continues an unknown write without removing its marker until the replacement operation settles", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    const lost = await store.runWrite(
      "thread-1",
      async () => Result.err(new SendUncertain({ message: "lost" })),
      isSendUncertain,
    );
    expect(lost.isErr() && lost.error._tag).toBe("SendUncertain");
    const started = deferred();
    const blocker = deferred();
    const continued = store.runWrite(
      "thread-1",
      async (_record, recovered) => {
        expect(recovered).toBe(true);
        started.resolve();
        await blocker.promise;
        return Result.ok("continued");
      },
      neverUnknown,
      () => true,
    );
    await started.promise;
    expect((await openStore()).get("thread-1")?.runState).toBe(
      "outcomeUnknown",
    );
    expect(store.get("thread-1")?.runState).toBe("running");
    blocker.resolve();
    const result = await continued;
    expect(result.isOk() && result.value).toBe("continued");
    expect((await openStore()).get("thread-1")?.runState).toBe("idle");
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
  model: "claude-opus-5-5",
};

const CLOUD = { sessionId: "session_01Cloud", shown: null };

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

const writeThenFailSyncOnce = () => {
  let failed = false;
  return async (target: string, content: string) => {
    const written = await writeFileAtomic(target, content);
    if (written.isErr() || failed) return written;
    failed = true;
    return Result.err(syncFailed(target));
  };
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
