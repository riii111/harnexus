import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { readClaudeSession } from "../infra/claude/session.ts";
import { openThreadStore } from "../infra/thread-store.ts";
import { conversation } from "../presentation/testing/session-record.ts";
import {
  FileSyncFailed,
  FileWriteFailed,
  writeFileAtomic,
} from "../runtime/fs.boundary.ts";
import { createHistoryRequests } from "./history-request.ts";
import { createRevertRequests } from "./revert-request.ts";
import type { Sent } from "./testing/harness.ts";
import { createThreadValues } from "./thread-values.ts";

describe("Claude conversation rewind", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "harnexus-revert-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("keeps the selected boundary across restart and serves only the retained history", async () => {
    const { revert, sent, closed } = await setup();
    await revert("thread/revert", {
      id: 1,
      params: { threadId: THREAD, beforeTurnId: "harnexus-history-u2" },
    });
    const restarted = await openThreadStore(statePath());
    expect(restarted.isOk() && restarted.value.get(THREAD)?.rewind).toEqual({
      sessionId: "se-1",
      at: "a3",
    });
    if (restarted.isErr()) return expect.unreachable("store failed");
    const threads = createThreadValues(restarted.value, () => {});
    const history = createHistoryRequests({
      threads,
      readSession,
      send: () => {},
      log: () => {},
    });
    const loaded = await history.load(THREAD);
    expect(loaded.isOk() && loaded.value.map((entry) => entry.turn.id)).toEqual(
      ["harnexus-history-u1"],
    );
    expect(closed).toEqual([THREAD]);
    expect(sent[0]).toMatchObject({
      id: 1,
      result: {
        thread: { id: THREAD, turns: [] },
        turnsBackwardsCursor: "at:harnexus-history-u1",
      },
    });
    expect(sent[1]).toEqual({
      method: "thread/reverted",
      params: { threadId: THREAD },
    });
    await restarted.value.setSessionId(THREAD, "se-2");
    expect(restarted.value.get(THREAD)?.rewind).toBeUndefined();
  });

  test("clears the pending rewind when a different conversation is selected", async () => {
    const { revert, store } = await setup();
    await revert("thread/revert", {
      id: 1,
      params: { threadId: THREAD, beforeTurnId: "harnexus-history-u2" },
    });
    const bound = await store.bindSession(THREAD, "se-2");
    expect(bound.isOk()).toBe(true);
    expect(store.get(THREAD)?.sessionId).toBe("se-2");
    expect(store.get(THREAD)?.rewind).toBeUndefined();
  });

  test("reloads an in-flight history read when the conversation is rewound", async () => {
    const { revert, store } = await setup();
    const first =
      Promise.withResolvers<Awaited<ReturnType<typeof readSession>>>();
    let reads = 0;
    const history = createHistoryRequests({
      threads: createThreadValues(store, () => {}),
      readSession: (sessionId) =>
        ++reads === 1 ? first.promise : readSession(sessionId),
      send: () => {},
      log: () => {},
    });
    const original = history.load(THREAD);
    await revert("thread/revert", {
      id: 1,
      params: { threadId: THREAD, beforeTurnId: "harnexus-history-u2" },
    });
    const afterRewind = history.load(THREAD);
    first.resolve(await readSession("se-1"));
    for (const loaded of await Promise.all([original, afterRewind]))
      expect(
        loaded.isOk() && loaded.value.map((entry) => entry.turn.id),
      ).toEqual(["harnexus-history-u1"]);
    expect(reads).toBe(2);
  });

  test("rewinds a live turn using the prompt UUID and supports dropping the first turn", async () => {
    const { revert, store } = await setup();
    await revert("thread/revert", {
      id: 1,
      params: { threadId: THREAD, beforeTurnId: "live-turn-1" },
    });
    expect(store.get(THREAD)?.rewind).toEqual({ sessionId: "se-1", at: null });
  });

  test("rolls back from the already rewound conversation rather than its discarded tail", async () => {
    const { revert, store, sent } = await setup();
    await revert("thread/revert", {
      id: 1,
      params: { threadId: THREAD, beforeTurnId: "harnexus-history-u2" },
    });
    await revert("thread/rollback", {
      id: 2,
      params: { threadId: THREAD, numTurns: 1 },
    });
    expect(store.get(THREAD)?.rewind?.at).toBeNull();
    expect(sent[2]).toMatchObject({
      id: 2,
      result: { thread: { turns: [] }, turnsBackwardsCursor: null },
    });
  });

  test.each([
    {
      name: "an unknown turn",
      beforeTurnId: "harnexus-history-missing",
      busy: false,
    },
    { name: "a running turn", beforeTurnId: "harnexus-history-u2", busy: true },
  ])("rejects $name before changing the conversation", async ({
    beforeTurnId,
    busy,
  }) => {
    const { revert, store, closed, sent } = await setup({ busy });
    await revert("thread/revert", {
      id: 1,
      params: { threadId: THREAD, beforeTurnId },
    });
    expect(store.get(THREAD)?.rewind).toBeUndefined();
    expect(closed).toEqual([]);
    expect(sent[0]).toMatchObject({ id: 1, error: { code: -32600 } });
  });

  test("closes the old session when the rewind was renamed but its sync failed", async () => {
    const { revert, store, closed, sent } = await setup({ failSync: true });
    await revert("thread/revert", {
      id: 1,
      params: { threadId: THREAD, beforeTurnId: "harnexus-history-u2" },
    });
    expect(store.get(THREAD)?.rewind).toEqual({ sessionId: "se-1", at: "a3" });
    expect(closed).toEqual([THREAD]);
    expect(sent[0]).toMatchObject({
      id: 1,
      error: {
        message:
          "the rewind was written but could not be confirmed; reopen the thread to check its retained history",
      },
    });
  });

  test("keeps the old conversation and session open when saving the rewind fails", async () => {
    const { revert, store, closed, sent } = await setup({ failSave: true });
    await revert("thread/revert", {
      id: 1,
      params: { threadId: THREAD, beforeTurnId: "harnexus-history-u2" },
    });
    expect(store.get(THREAD)?.rewind).toBeUndefined();
    expect(closed).toEqual([]);
    expect(sent[0]).toMatchObject({ id: 1, error: { code: -32600 } });
  });
});

let directory: string;
const THREAD = "thread-fixture";
const statePath = () => join(directory, "threads.json");
const messages = conversation();
const readSession: typeof readClaudeSession = (sessionId) =>
  readClaudeSession(sessionId, { read: async () => messages });
const setup = async ({
  busy = false,
  failSave = false,
  failSync = false,
}: {
  busy?: boolean;
  failSave?: boolean;
  failSync?: boolean;
} = {}) => {
  let fail = false;
  const opened = await openThreadStore(
    statePath(),
    failSave || failSync
      ? {
          writeState: async (path, content) => {
            if (fail && failSave)
              return Result.err(
                new FileWriteFailed({
                  path,
                  cause: null,
                  message: "disk full",
                }),
              );
            const written = await writeFileAtomic(path, content);
            return fail && failSync && written.isOk()
              ? Result.err(
                  new FileSyncFailed({
                    path,
                    cause: null,
                    message: "sync failed",
                  }),
                )
              : written;
          },
        }
      : {},
  );
  if (opened.isErr()) return expect.unreachable("store failed");
  const store = opened.value;
  await store.register({
    threadId: THREAD,
    model: "claude-sonnet-4-6",
    worktree: directory,
  });
  await store.setSessionId(THREAD, "se-1");
  fail = failSave || failSync;
  const threads = createThreadValues(store, () => {});
  const sent: Sent[] = [];
  const closed: string[] = [];
  const revert = createRevertRequests({
    store,
    threads,
    turns: {
      changeConversation: async (_threadId, change) => (busy ? null : change()),
    },
    runtime: {
      closeSession: (id) => closed.push(id),
      recordOf: (_threadId, turnId) => (turnId === "live-turn-1" ? "u1" : null),
    },
    readSession,
    request: async () => Result.ok({ thread: { id: THREAD, cwd: directory } }),
    send: (message) => sent.push(message),
  });
  return { revert, store, sent, closed };
};
