import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import {
  FileSyncFailed,
  FileWriteFailed,
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
  test("starts empty when the file does not exist", async () => {
    const store = await openStore();

    expect(store.get("thread-1")).toBeUndefined();
  });

  test("restores the saved mapping in a new store", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.setSession("thread-1", "session-1");
    await store.addReviewer("thread-1", "reviewer-1");
    await store.setModel("thread-1", "claude-opus-5-5");

    const reopened = await openStore();

    expect(reopened.get("thread-1")).toEqual({
      threadId: "thread-1",
      sessionId: "session-1",
      model: "claude-opus-5-5",
      worktree: "/work/tree",
      reviewerThreadIds: ["reviewer-1"],
      runState: "idle",
    });
  });

  test("saves the file readable only by the owner", async () => {
    const store = await openStore();
    await store.register(ENTRY);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("refuses a file that is not valid JSON", async () => {
    await writeFile(path, '{"version":1,"threads":[');

    const opened = await openThreadStore(path);

    expect(opened.isErr() && opened.error._tag).toBe("StateFileCorrupt");
  });

  test("refuses a file whose records do not match the format", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        threads: [{ ...SAVED_RECORD, runState: "paused" }],
      }),
    );

    const opened = await openThreadStore(path);

    expect(opened.isErr() && opened.error._tag).toBe("StateFileCorrupt");
  });

  test("refuses a file with the same thread twice", async () => {
    await writeFile(
      path,
      JSON.stringify({ version: 1, threads: [SAVED_RECORD, SAVED_RECORD] }),
    );

    const opened = await openThreadStore(path);

    expect(opened.isErr() && opened.error._tag).toBe("StateFileCorrupt");
  });

  test("loads a thread that was running as outcome unknown", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        threads: [{ ...SAVED_RECORD, runState: "running" }],
      }),
    );

    const store = await openStore();

    expect(store.get("thread-1")?.runState).toBe("outcomeUnknown");
  });

  test("ignores a temporary file left by an interrupted write", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await writeFile(join(dir, `.threads.json.leftover.tmp`), '{"vers');

    const reopened = await openStore();

    expect(reopened.get("thread-1")?.threadId).toBe("thread-1");
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

    const updated = await store.setSession("thread-9", "session-1");

    expect(updated.isErr() && updated.error._tag).toBe("ThreadNotFound");
  });

  test("keeps each reviewer once", async () => {
    const store = await openStore();
    await store.register(ENTRY);
    await store.addReviewer("thread-1", "reviewer-1");
    await store.addReviewer("thread-1", "reviewer-1");

    expect(store.get("thread-1")?.reviewerThreadIds).toEqual(["reviewer-1"]);
  });

  test("keeps the previous state when a write fails before the rename", async () => {
    const good = await openStore();
    await good.register(ENTRY);
    const store = await openStore(failingWrite);

    const updated = await store.setSession("thread-1", "session-1");

    expect(updated.isErr() && updated.error._tag).toBe("StatePersistFailed");
    expect(store.get("thread-1")?.sessionId).toBeNull();
    expect((await openStore()).get("thread-1")?.sessionId).toBeNull();
  });

  test("follows the file and stops saving when the rename is not confirmed", async () => {
    const good = await openStore();
    await good.register(ENTRY);
    const store = await openStore(writeThenFailSync);

    const updated = await store.setSession("thread-1", "session-1");
    const later = await store.setModel("thread-1", "claude-opus-5-5");

    expect(updated.isErr() && updated.error._tag).toBe("StatePersistFailed");
    expect(store.get("thread-1")?.sessionId).toBe("session-1");
    expect(later.isErr() && later.error._tag).toBe("StateStoreHalted");
    expect((await openStore()).get("thread-1")).toMatchObject({
      sessionId: "session-1",
      model: "claude-sonnet-5",
    });
  });

  test("rejects values that could not be loaded again", async () => {
    const store = await openStore();
    await store.register(ENTRY);

    const updated = await store.setSession("thread-1", "");
    const registered = await store.register({
      ...ENTRY,
      threadId: "thread-2",
      model: "",
    });

    expect(updated.isErr() && updated.error._tag).toBe("InvalidThreadRecord");
    expect(registered.isErr() && registered.error._tag).toBe(
      "InvalidThreadRecord",
    );
    expect((await openStore()).get("thread-1")?.sessionId).toBeNull();
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
      never,
    );
    const second = store.runWrite(
      "thread-1",
      async () => {
        events.push("second:start");
        return Result.ok(2);
      },
      never,
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
      never,
    );
    const second = await store.runWrite(
      "thread-2",
      async () => Result.ok("second"),
      never,
    );

    expect(second.isOk() && second.value).toBe("second");
    expect(store.get("thread-1")?.runState).toBe("running");
    blocker.resolve();
    await first;
  });

  test("finishes a write while another thread's change is being saved", async () => {
    const gated = gatedWrite();
    const store = await openStore(gated.write);
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
      never,
    );
    await started.promise;
    const held = gated.hold();
    const session = store.setSession("thread-2", "session-2");
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
        saved = store.setSession("thread-1", "session-1");
        return Result.ok(null);
      },
      never,
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
      never,
    );

    await expect(rejected).rejects.toThrow("boom");
    expect(store.get("thread-1")?.runState).toBe("outcomeUnknown");
    await store.resolveOutcomeUnknown("thread-1");
    const retried = await store.runWrite(
      "thread-1",
      async () => Result.ok("sent"),
      never,
    );
    expect(retried.isOk() && retried.value).toBe("sent");
  });

  test("reports a finished write whose state could not be saved", async () => {
    const switchable = switchableWrite();
    const store = await openStore(switchable.write);
    await store.register(ENTRY);

    const result = await store.runWrite(
      "thread-1",
      async () => {
        switchable.failNext();
        return Result.ok("sent");
      },
      never,
    );

    let repeated = false;
    const again = await store.runWrite(
      "thread-1",
      async () => {
        repeated = true;
        return Result.ok("sent");
      },
      never,
    );

    expect(result.isErr() && result.error._tag).toBe("RunStateNotSaved");
    expect(store.get("thread-1")?.runState).toBe("outcomeUnknown");
    expect(again.isErr() && again.error._tag).toBe("WriteOutcomeUnknown");
    expect(repeated).toBe(false);
    expect((await openStore()).get("thread-1")?.runState).toBe(
      "outcomeUnknown",
    );
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
      never,
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
      never,
    );

    expect(retried.isOk() && retried.value).toBe("sent");
  });

  test("does not start a write whose running state cannot be saved", async () => {
    const good = await openStore();
    await good.register(ENTRY);
    const store = await openStore(failingWrite);
    let called = false;

    const result = await store.runWrite(
      "thread-1",
      async () => {
        called = true;
        return Result.ok(null);
      },
      never,
    );

    expect(result.isErr() && result.error._tag).toBe("StatePersistFailed");
    expect(called).toBe(false);
    expect(store.get("thread-1")?.runState).toBe("idle");
  });

  test("keeps updates made while the write was running", async () => {
    const store = await openStore();
    await store.register(ENTRY);

    await store.runWrite(
      "thread-1",
      async () => {
        await store.setSession("thread-1", "session-1");
        return Result.ok(null);
      },
      never,
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
      never,
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

const never = () => false;

const ENTRY = {
  threadId: "thread-1",
  model: "claude-sonnet-5",
  worktree: "/work/tree",
};

const SAVED_RECORD = {
  ...ENTRY,
  sessionId: null,
  reviewerThreadIds: [],
  runState: "idle",
};

const openStore = async (write = writeFileAtomic) => {
  const opened = await openThreadStore(path, write);
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
  return Result.err(
    new FileSyncFailed({
      path: target,
      cause: new Error("fsync failed"),
      message: `wrote ${target} but cannot sync its directory`,
    }),
  );
};

const switchableWrite = () => {
  let fail = false;
  return {
    write: (target: string, content: string) => {
      if (!fail) return writeFileAtomic(target, content);
      fail = false;
      return failingWrite(target);
    },
    failNext: () => {
      fail = true;
    },
  };
};

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
