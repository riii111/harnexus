import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "better-result";
import { startClaudeSession } from "../../infra/claude/session.ts";
import { fakeClaude } from "../../infra/claude/testing/fake-claude.ts";
import { createEmptyFile, writeFileAtomic } from "../../runtime/fs.boundary.ts";
import {
  ALLOWED_TOOLS,
  answer,
  appRequest,
  askTool,
  claudeDir,
  completedItems,
  completedTurnStatuses,
  completedTurns,
  completeTurn,
  createGate,
  dir,
  diskFull,
  firstPrompt,
  harness,
  interrupt,
  MODEL,
  OTHER_THREAD,
  readPrompts,
  responseTo,
  type Sent,
  SUBSCRIPTION,
  sdk,
  settle,
  startedTurns,
  success,
  THREAD,
  turnCompleted,
  turnStart,
  until,
  useTempDir,
} from "../testing/harness.ts";
import {
  ALLOWED,
  type FakeClaude,
  INIT,
  isTurnStarted,
  ownResult,
  steer,
  taskStarted,
} from "./testing/runtime-fixtures.ts";

useTempDir();

describe("canceling Claude session startup", () => {
  test("cancels a stuck account lookup while preserving a slow valid startup and its next turn", async () => {
    const accountGate = createGate();
    const normalAccountGate = createGate();
    const first = fakeClaude(new Error("account lookup failed"), {
      accountAnswered: accountGate.promise,
    });
    const second = fakeClaude(SUBSCRIPTION, {
      accountAnswered: normalAccountGate.promise,
    });
    const { turns, sent, settings } = await harness([first, second]);

    turns.startTurn(turnStart(10, "first"), undefined);
    await until(() => first.started());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)?.status).toBe("interrupted");
    expect(first.closes()).toBe(1);
    expect(first.interrupts()).toBe(0);
    expect(await first.prompts()).toEqual([]);

    turns.startTurn(turnStart(11, "second"), undefined);
    await until(() => second.started());
    expect(second.closes()).toBe(0);
    normalAccountGate.open();
    await normalAccountGate.promise;
    expect(await firstPrompt(second.prompt())).toBe("second");
    await answerAndComplete(second, sent, "msg-2", 2);

    accountGate.open();
    await accountGate.promise;
    turns.startTurn(turnStart(12, "third"), undefined);
    await until(() => responseTo(sent, 12) !== undefined);
    expect(await firstPrompt(second.prompt())).toBe("third");
    await answerAndComplete(second, sent, "msg-3", 3);

    expect(settings).toHaveLength(2);
    expect(first.closes()).toBe(1);
  });

  test("closes a late successful start without starting its pump or replacing the current session", async () => {
    const lateStartGate = createGate();
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second], {
      startSession: async (session, signal, fake) => {
        if (fake === first) {
          await lateStartGate.promise;
          const started = await startClaudeSession(session, fake.runtime);
          if (started.isOk()) {
            fake.emit(sdk(answer("msg-late", "stale startup output")));
          }
          return started;
        }
        return startClaudeSession(session, fake.runtime, signal);
      },
    });

    turns.startTurn(turnStart(10, "first"), undefined);
    await until(() => settings.length === 1);
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => completedTurnStatuses(sent).length === 1);

    turns.startTurn(turnStart(11, "second"), undefined);
    await until(() => second.started());
    expect(await firstPrompt(second.prompt())).toBe("second");
    await answerAndComplete(second, sent, "msg-2", 2);

    lateStartGate.open();
    await until(() => first.closes() === 1);
    expect(first.nextCalls()).toBe(0);
    expect(await first.prompts()).toEqual([]);
    expect(JSON.stringify(sent)).not.toContain("stale startup output");

    turns.startTurn(turnStart(12, "reuse second"), undefined);
    await until(() => responseTo(sent, 12) !== undefined);
    expect(await firstPrompt(second.prompt())).toBe("reuse second");
    await answerAndComplete(second, sent, "msg-3", 3);

    expect(settings).toHaveLength(2);
    turns.closeAll();
  });

  test("interrupts a prior-record lookup and reuses the existing session", async () => {
    const advancedGate = createGate();
    const advancedFinished = createGate();
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let recordReads = 0;
    const { turns, sent, settings, store, gates } = await harness(
      [first, second],
      {
        lastRecord: async () => {
          recordReads += 1;
          if (recordReads === 2) {
            await advancedGate.promise;
            advancedFinished.open();
            return Result.ok("record-after");
          }
          return Result.ok("record-before");
        },
        lookupSession: async () => Result.ok(true),
      },
    );

    await completeTurn(turns, sent, first, 10);
    expect(await firstPrompt(first.prompt())).toBe("prompt 10");
    await until(() => recordReads === 1);
    turns.startTurn(turnStart(11, "stop during lookup"), undefined);
    await until(() => recordReads === 2);
    turns.interruptTurn(interrupt(20, "turn-2"));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(first.interrupts()).toBe(0);
    expect(first.closes()).toBe(0);
    expect(gates.slice(0, 2)).toEqual(["accept", "stop"]);

    turns.startTurn(turnStart(12, "continue after interrupt"), undefined);
    await until(() => responseTo(sent, 12) !== undefined);
    expect(await firstPrompt(first.prompt())).toBe("continue after interrupt");
    expect(gates).toEqual(["accept", "stop", "stop", "accept"]);
    await answerAndComplete(first, sent, "msg-3", 3);

    advancedGate.open();
    await advancedFinished.promise;
    await until(() => store.get(THREAD)?.runState === "idle");
    expect(second.started()).toBe(false);
    expect(settings).toHaveLength(1);
    expect(first.closes()).toBe(0);
  });

  test("does not let a cancelled resume lookup replace a later session", async () => {
    const resumeGate = createGate();
    const staleLookupFinished = createGate();
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let lookups = 0;
    const { turns, sent, settings } = await harness([first, second], {
      lookupSession: async () => {
        lookups += 1;
        if (lookups === 1) {
          await resumeGate.promise;
          staleLookupFinished.open();
        }
        return Result.ok(true);
      },
    });

    turns.startTurn(turnStart(10, "first"), undefined);
    await until(() => first.started());
    expect(await firstPrompt(first.prompt())).toBe("first");
    first.emit(sdk(answer("msg-1", "partial")));
    await until(() => first.drained());
    first.fail(new Error("socket closed"));
    await until(() => turnCompleted(sent) !== undefined);

    turns.startTurn(turnStart(11, "cancelled resume"), undefined);
    await until(() => lookups === 1);
    turns.interruptTurn(interrupt(20, "turn-2"));
    await until(() => completedTurnStatuses(sent).length === 2);

    turns.startTurn(turnStart(12, "new session"), undefined);
    await until(() => second.started());
    expect(await firstPrompt(second.prompt())).toBe("new session");
    await answerAndComplete(second, sent, "msg-2", 3);

    resumeGate.open();
    await staleLookupFinished.promise;
    turns.startTurn(turnStart(13, "reuse new session"), undefined);
    await until(() => responseTo(sent, 13) !== undefined);
    expect(await firstPrompt(second.prompt())).toBe("reuse new session");
    await answerAndComplete(second, sent, "msg-3", 4);

    expect(lookups).toBe(2);
    expect(settings).toHaveLength(2);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
    turns.closeAll();
  });

  test.each<{
    name: string;
    sentPrompts: string[];
    waitOnLookup: (lookup: Gate) => Promise<{
      claude: FakeClaude;
      started: Started;
      turnsEnded: number;
      lookupEnded: Promise<void>;
    }>;
  }>([
    {
      name: "a prior-record lookup",
      sentPrompts: ["prompt 10"],
      waitOnLookup: async (lookup) => {
        const claude = fakeClaude(SUBSCRIPTION);
        const lookupEnded = createGate();
        let recordReads = 0;
        const started = await harness([claude], {
          lastRecord: async () => {
            recordReads += 1;
            if (recordReads === 2) {
              await lookup.promise;
              lookupEnded.open();
              return Result.ok("record-after");
            }
            return Result.ok("record-before");
          },
          lookupSession: async () => Result.ok(true),
        });
        await completeTurn(started.turns, started.sent, claude, 10);
        started.turns.startTurn(
          turnStart(11, "close during lookup"),
          undefined,
        );
        await until(() => recordReads === 2);
        return {
          claude,
          started,
          turnsEnded: 2,
          lookupEnded: lookupEnded.promise,
        };
      },
    },
    {
      name: "an account lookup",
      sentPrompts: [],
      waitOnLookup: async (lookup) => {
        const claude = fakeClaude(SUBSCRIPTION, {
          accountAnswered: lookup.promise,
        });
        const started = await harness([claude]);
        started.turns.startTurn(turnStart(10, "hello"), undefined);
        await until(() => claude.started());
        return {
          claude,
          started,
          turnsEnded: 1,
          lookupEnded: lookup.promise,
        };
      },
    },
  ])("closeAll completes a turn waiting on $name and closes the query once", async ({
    sentPrompts,
    waitOnLookup,
  }) => {
    const lookup = createGate();
    const { claude, started, turnsEnded, lookupEnded } =
      await waitOnLookup(lookup);

    started.turns.closeAll();
    await until(
      () => completedTurnStatuses(started.sent).length === turnsEnded,
    );
    expect(completedTurnStatuses(started.sent).at(-1)).toBe("failed");
    expect(claude.closes()).toBe(1);
    lookup.open();
    await lookupEnded;

    expect(started.settings).toHaveLength(1);
    expect(claude.closes()).toBe(1);
    expect(
      (await claude.prompts()).map((prompt) => prompt.message.content),
    ).toEqual(sentPrompts);
  });
});

describe("session ids", () => {
  test("recovers an unsaved session id from the same process after an unsettled write", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let unsettled = true;
    const started = await harness([first, second], {
      unsettledWrite: () => unsettled,
      files: {
        writeState: (path, content) =>
          content.includes('"se-1"')
            ? diskFull(path)
            : writeFileAtomic(path, content),
      },
    });
    await completeTurn(started.turns, started.sent, first, 10);
    await until(() => started.store.get(THREAD)?.runState === "outcomeUnknown");
    unsettled = false;
    await completeTurn(started.turns, started.sent, second, 11, "fresh-input");
    await until(() => started.store.get(THREAD)?.runState === "idle");
    expect(started.settings[1]).toMatchObject({ resume: "se-1" });
    expect(completedTurns(started.sent)[1]?.status).toBe("completed");
    expect(started.store.get(THREAD)?.runState).toBe("idle");
  });

  test("keeps an unknown turn blocked after its initial session id was not saved and the App restarted", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const before = await harness([first], {
      unsettledWrite: () => true,
      files: {
        writeState: (path, content) =>
          content.includes('"se-1"')
            ? diskFull(path)
            : writeFileAtomic(path, content),
      },
    });
    await completeTurn(before.turns, before.sent, first, 10);
    await until(() => before.store.get(THREAD)?.runState === "outcomeUnknown");
    expect(before.events).toContainEqual({
      event: "claude_turn",
      step: "session_not_saved",
      error: "StatePersistFailed",
    });

    const second = fakeClaude(SUBSCRIPTION);
    const after = await harness([second]);
    expect(after.store.get(THREAD)?.sessionId).toBeNull();
    const retry = turnStart(11, "continue");
    after.turns.startTurn(
      { ...retry, params: { ...retry.params, clientUserMessageId: "new-id" } },
      undefined,
    );
    await until(() => completedTurnStatuses(after.sent).length === 1);
    await until(() => after.store.get(THREAD)?.runState === "outcomeUnknown");
    expect(completedTurns(after.sent)[0]?.error?.message).toContain(
      "previous Claude conversation could not be restored; use /resume",
    );
    expect(second.started()).toBe(false);
    expect(after.settings).toHaveLength(0);
    const reloaded = await harness([]);
    expect(reloaded.store.get(THREAD)).toMatchObject({
      sessionId: null,
      runState: "outcomeUnknown",
    });
  });

  test("keeps validating a missing rewind source when clearing its saved session id fails", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const before = await harness([source]);
    await completeTurn(before.turns, before.sent, source, 10);
    await until(() => before.store.get(THREAD)?.runState === "idle");
    const saved = await before.store.setRewind(THREAD, {
      sessionId: "se-1",
      at: "kept-record",
    });
    expect(saved.isOk()).toBe(true);
    const claude = fakeClaude(SUBSCRIPTION);
    const lookedUp: string[] = [];
    const after = await harness([claude], {
      lookupSession: async (id) => {
        lookedUp.push(id);
        return Result.ok(false);
      },
      files: {
        writeState: (path, content) =>
          /"sessionId":\s*null/.test(content)
            ? diskFull(path)
            : writeFileAtomic(path, content),
      },
    });
    after.turns.startTurn(turnStart(11, "continue"), undefined);
    await until(() => completedTurnStatuses(after.sent).length === 1);
    await until(() => after.store.get(THREAD)?.runState === "outcomeUnknown");
    const retry = turnStart(12, "check again");
    after.turns.startTurn(
      { ...retry, params: { ...retry.params, clientUserMessageId: "new-id" } },
      undefined,
    );
    await until(() => completedTurnStatuses(after.sent).length === 2);
    expect(
      completedTurns(after.sent).map((turn) => turn.error?.message),
    ).toEqual([
      expect.stringContaining(
        "missing Claude conversation could not be cleared",
      ),
      expect.stringContaining(
        "missing Claude conversation could not be cleared",
      ),
    ]);
    expect(lookedUp).toEqual(["se-1", "se-1"]);
    expect(claude.started()).toBe(false);
    await until(() => after.store.get(THREAD)?.runState === "outcomeUnknown");
    const reloaded = await harness([]);
    expect(reloaded.store.get(THREAD)).toMatchObject({
      runState: "outcomeUnknown",
      sessionId: "se-1",
      rewind: { sessionId: "se-1", at: "kept-record" },
    });
  });

  test("fails a rewind fork and keeps its durable unknown marker after a write failure", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const before = await harness([source]);
    await completeTurn(before.turns, before.sent, source, 10);
    await until(() => before.store.get(THREAD)?.runState === "idle");
    const rewind = await before.store.setRewind(THREAD, {
      sessionId: "se-1",
      at: "kept-record",
    });
    expect(rewind.isOk()).toBe(true);
    const fork = fakeClaude(SUBSCRIPTION);
    const after = await harness([fork], {
      files: {
        writeState: async (path, content) =>
          content.includes('"se-rewound"')
            ? diskFull(path)
            : writeFileAtomic(path, content),
      },
    });
    after.turns.startTurn(turnStart(11, "continue from the rewind"), undefined);
    await until(() => fork.prompted());
    expect(after.settings[0]).toMatchObject({
      resume: "se-1",
      forkSession: true,
      resumeAt: "kept-record",
    });
    fork.emit(
      sdk({ ...answer("fork-answer", "partial"), session_id: "se-rewound" }),
    );
    fork.emit(sdk({ ...success(), session_id: "se-rewound" }));
    await until(() => after.store.get(THREAD)?.runState === "outcomeUnknown");
    expect(turnCompleted(after.sent)).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining("conversation could not be saved"),
      },
    });
    expect(fork.closes()).toBe(1);
    expect(after.events).toContainEqual({
      event: "claude_turn",
      step: "session_not_saved",
      error: "StatePersistFailed",
    });
    const reloaded = await harness([]);
    expect(reloaded.store.get(THREAD)?.runState).toBe("outcomeUnknown");
    expect(reloaded.store.get(THREAD)?.sessionId).toBe("se-1");
    expect(reloaded.store.get(THREAD)?.rewind).toEqual({
      sessionId: "se-1",
      at: "kept-record",
    });
  });
});

describe("a fork of a Claude thread", () => {
  // Claude names a project folder after its directory with every other character as a hyphen.
  const writeSourceRecord = async (uuids: string[]) => {
    const folder = join(
      claudeDir(),
      "projects",
      dir.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "se-1.jsonl"),
      uuids
        .map((uuid) => `${JSON.stringify({ type: "assistant", uuid })}\n`)
        .join(""),
    );
  };

  const forkTurn = async (
    started: Awaited<ReturnType<typeof harness>>,
    claude: ReturnType<typeof fakeClaude>,
    id: number,
  ) => {
    started.turns.startTurn(turnStart(id, "aside", OTHER_THREAD), undefined);
    await until(() => responseTo(started.sent, id) !== undefined);
    claude.emit(sdk({ ...answer(`msg-${id}`, "ok"), session_id: "se-fork" }));
    claude.emit(sdk({ ...success(), session_id: "se-fork" }));
    await until(() => completedTurnStatuses(started.sent).length === 2);
  };

  // The source's turn leaves its conversation as se-1, whose record ends at the given records.
  const forkAfterSource = async (
    started: Awaited<ReturnType<typeof harness>>,
    source: ReturnType<typeof fakeClaude>,
    records: string[],
  ) => {
    await completeTurn(started.turns, started.sent, source, 10);
    if (records.length > 0) await writeSourceRecord(records);
    await started.turns.adoptFork(
      OTHER_THREAD,
      { model: MODEL, cwd: dir },
      THREAD,
    );
  };

  test("starts its own conversation from the source's as it stood at the fork and leaves the source's alone", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const fork = fakeClaude(SUBSCRIPTION);
    const started = await harness([source, fork]);
    await forkAfterSource(started, source, ["a-1"]);
    await writeSourceRecord(["a-1", "a-2"]);

    await forkTurn(started, fork, 11);

    expect(started.settings[1]).toMatchObject({
      resume: "se-1",
      forkSession: true,
      resumeAt: "a-1",
    });
    await until(() => started.store.get(OTHER_THREAD)?.sessionId === "se-fork");
    expect(started.store.get(THREAD)?.sessionId).toBe("se-1");
  });

  test("starts from where a rewound source stands rather than its record's end", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const fork = fakeClaude(SUBSCRIPTION);
    const started = await harness([source, fork]);
    await completeTurn(started.turns, started.sent, source, 10);
    await writeSourceRecord(["a-1", "a-2"]);
    const rewound = await started.store.setRewind(THREAD, {
      sessionId: "se-1",
      at: "a-1",
    });
    await started.turns.adoptFork(
      OTHER_THREAD,
      { model: MODEL, cwd: dir },
      THREAD,
    );

    await forkTurn(started, fork, 11);

    expect(rewound.isOk()).toBe(true);
    expect(started.settings[1]).toMatchObject({
      resume: "se-1",
      forkSession: true,
      resumeAt: "a-1",
    });
  });

  test.each<{
    name: string;
    options: Parameters<typeof harness>[1];
    prepare: (started: Started, source: FakeClaude) => Promise<void>;
  }>([
    {
      name: "the source was rewound to its start",
      options: {},
      prepare: async (started, source) => {
        await completeTurn(started.turns, started.sent, source, 10);
        await writeSourceRecord(["a-1"]);
        const rewound = await started.store.setRewind(THREAD, {
          sessionId: "se-1",
          at: null,
        });
        expect(rewound.isOk()).toBe(true);
        await started.turns.adoptFork(
          OTHER_THREAD,
          { model: MODEL, cwd: dir },
          THREAD,
        );
      },
    },
    {
      name: "the source had said nothing when forked, even once it has",
      options: {},
      prepare: async (started, source) => {
        await forkAfterSource(started, source, []);
        await writeSourceRecord(["a-1"]);
      },
    },
    {
      name: "the source's is gone",
      options: { missingSessions: ["se-1"] },
      prepare: (started, source) => forkAfterSource(started, source, ["a-1"]),
    },
    {
      name: "the source had none when forked",
      options: {},
      prepare: async (started, source) => {
        await started.turns.adoptFork(
          OTHER_THREAD,
          { model: MODEL, cwd: dir },
          THREAD,
        );
        await completeTurn(started.turns, started.sent, source, 10);
      },
    },
  ])("starts a conversation of its own when $name", async ({
    options,
    prepare,
  }) => {
    const source = fakeClaude(SUBSCRIPTION);
    const fork = fakeClaude(SUBSCRIPTION);
    const started = await harness([source, fork], options);
    await prepare(started, source);

    await forkTurn(started, fork, 11);

    expect(started.settings[1]?.resume).toBeUndefined();
    expect(started.settings[1]?.forkSession).toBeUndefined();
  });

  test("fails the turn without starting Claude when the source's record could not be read at the fork", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const fork = fakeClaude(SUBSCRIPTION);
    const started = await harness([source, fork]);
    // A project folder that links to itself cannot be listed.
    const project = join(claudeDir(), "projects", "-work-tree");
    await mkdir(join(claudeDir(), "projects"), { recursive: true });
    await symlink(project, project);
    await forkAfterSource(started, source, []);

    started.turns.startTurn(turnStart(11, "aside", OTHER_THREAD), undefined);
    await until(() => completedTurnStatuses(started.sent).length === 2);

    expect(completedTurns(started.sent).at(-1)).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("could not be read") },
    });
    expect(fork.started()).toBe(false);
    expect(started.settings).toHaveLength(1);
  });

  test("fails the turn and keeps the source's id off the fork when Claude stays in the source's conversation", async () => {
    const source = fakeClaude(SUBSCRIPTION);
    const fork = fakeClaude(SUBSCRIPTION);
    const started = await harness([source, fork]);
    await forkAfterSource(started, source, ["a-1"]);

    started.turns.startTurn(turnStart(11, "aside", OTHER_THREAD), undefined);
    await until(() => responseTo(started.sent, 11) !== undefined);
    fork.emit(sdk(answer("msg-11", "ok")));
    await until(() => completedTurnStatuses(started.sent).length === 2);

    expect(completedTurnStatuses(started.sent)).toEqual([
      "completed",
      "failed",
    ]);
    expect(started.store.get(OTHER_THREAD)?.sessionId ?? null).toBeNull();
    expect(started.store.get(THREAD)?.sessionId).toBe("se-1");
  });
});

describe("a saved session Claude no longer has", () => {
  test("fails the turn without starting Claude and starts a new conversation on the next turn", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const before = await harness([first]);
    await completeTurn(before.turns, before.sent, first, 10);
    await until(() => before.store.get(THREAD)?.runState === "idle");
    const second = fakeClaude(SUBSCRIPTION);

    const after = await harness([second], { missingSessions: ["se-1"] });
    after.turns.startTurn(turnStart(11, "hello"), undefined);
    await until(() => turnCompleted(after.sent) !== undefined);
    const failedStarted = second.started();
    await until(() => after.store.get(THREAD)?.sessionId === null);
    await completeTurn(after.turns, after.sent, second, 12);

    expect(turnCompleted(after.sent)).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("send again") },
    });
    expect(failedStarted).toBe(false);
    expect(after.settings).toHaveLength(1);
    expect(after.settings[0]?.resume).toBeUndefined();
    expect(after.events).toContainEqual({
      event: "claude_turn",
      step: "session_missing",
    });
  });

  test("starts a new conversation after a lost session even when forgetting its id cannot be saved", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const before = await harness([first]);
    await completeTurn(before.turns, before.sent, first, 10);
    await until(() => before.store.get(THREAD)?.runState === "idle");
    const second = fakeClaude(SUBSCRIPTION);

    const after = await harness([second], {
      missingSessions: ["se-1"],
      files: { writeState: diskFull },
    });
    after.turns.startTurn(turnStart(11, "hello"), undefined);
    await until(() => turnCompleted(after.sent) !== undefined);
    await until(() =>
      after.events.some((event) => event.step === "session_not_saved"),
    );
    await completeTurn(after.turns, after.sent, second, 12);

    expect(after.store.get(THREAD)?.sessionId).toBe("se-1");
    expect(after.settings).toHaveLength(1);
    expect(after.settings[0]?.resume).toBeUndefined();
    expect(completedTurnStatuses(after.sent)).toEqual(["failed", "completed"]);
  });

  test("resumes the saved session when its record cannot be looked up", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const before = await harness([first]);
    await completeTurn(before.turns, before.sent, first, 10);
    await until(() => before.store.get(THREAD)?.runState === "idle");
    const second = fakeClaude(SUBSCRIPTION);

    const after = await harness([second], { sessionLookupFails: true });
    await completeTurn(after.turns, after.sent, second, 11);

    expect(after.settings[0]).toMatchObject({ resume: "se-1" });
    expect(completedTurnStatuses(after.sent)).toEqual(["completed"]);
  });
});

describe("Claude's own turns", () => {
  // A background task that reports back after the last turn ended starts a turn of Claude's own, which reaches the next turn ahead of its reply.
  test.each([
    { name: "for a background task", fields: {} },
    {
      name: "to continue its work",
      fields: { origin: { kind: "auto-continuation" } },
    },
    {
      name: "for a send of another client",
      fields: { origin: undefined, user_message_uuids: ["uuid-elsewhere"] },
    },
  ])("keeps the turn open through a turn Claude ran $name before taking the prompt", async ({
    fields,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    const [prompt] = await readPrompts(claude, 1);
    claude.emit(sdk(answer("msg-1", "the agent finished")));
    claude.emit(sdk(ownResult(fields)));
    await until(() => claude.drained());
    expect(completedTurnStatuses(sent)).toEqual([]);
    claude.emit(sdk(answer("msg-2", "hi")));
    claude.emit(sdk(success([prompt?.uuid])));
    await until(() => turnCompleted(sent) !== undefined);

    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
    expect(turnCompleted(sent).items).toMatchObject([{ text: "hi" }]);
    expect(claude.closes()).toBe(0);
  });

  test("keeps a steer pending through a turn Claude ran on its own", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.steerTurn(steer(30, "turn-1", "also this"));
    const [prompt, steered] = await readPrompts(claude, 2);
    claude.emit(sdk(answer("msg-1", "first")));
    claude.emit(sdk(success([prompt?.uuid], 1)));
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    claude.emit(sdk(ownResult()));
    await until(() => claude.drained());
    expect(completedTurnStatuses(sent)).toEqual([]);
    claude.emit(sdk(answer("msg-3", "second")));
    claude.emit(sdk(success([steered?.uuid])));
    await until(() => turnCompleted(sent) !== undefined);

    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
    expect(turnCompleted(sent).items).toMatchObject([{ text: "second" }]);
    expect(claude.closes()).toBe(0);
  });

  // A prompt sent while Claude's own turn runs joins it, and the result then names it.
  test("ends the turn with a turn Claude started on its own that took the prompt", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    const [prompt] = await readPrompts(claude, 1);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(ownResult({ user_message_uuids: [prompt?.uuid] })));
    await until(() => turnCompleted(sent) !== undefined);

    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
  });
});

describe("subagent threads", () => {
  test.each<{
    name: string;
    applied: boolean;
    finishRewind: (runtime: Runtime) => void;
    status: "completed" | "interrupted";
    keepsOutput: boolean;
  }>([
    {
      name: "the rewind fails",
      applied: false,
      finishRewind: () => {},
      status: "completed",
      keepsOutput: true,
    },
    {
      name: "the rewind is applied",
      applied: true,
      finishRewind: (runtime) => runtime.closeSession(THREAD),
      status: "interrupted",
      keepsOutput: false,
    },
  ])("holds child output during a rewind and settles the child as $status when $name", async ({
    applied,
    finishRewind,
    status,
    keepsOutput,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, store, runtime, subagents } = await harness([claude]);
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    claude.emit(sdk(taskStarted("toolu-agent", 1)));
    claude.emit(sdk(success()));
    await until(() => store.get(THREAD)?.runState === "idle");
    await settle();
    const child = subagents.childrenOf(THREAD)[0];
    if (child === undefined) return expect.unreachable("child did not start");
    const gate = createGate();
    const changing = turns.changeConversation(THREAD, async () => {
      await gate.promise;
      finishRewind(runtime);
      return applied;
    });
    claude.emit(
      sdk({
        ...answer("msg-child", "held child output"),
        parent_tool_use_id: "toolu-agent",
      }),
    );
    claude.emit(sdk(taskNotification("toolu-agent")));
    await settle();
    expect(child.active).toBe(true);
    expect(JSON.stringify(subagents.historyOf(child.id))).not.toContain(
      "held child output",
    );
    gate.open();
    expect(await changing).toBe(applied);
    await until(() => subagents.childrenOf(THREAD)[0]?.active === false);
    const history = subagents.historyOf(child.id);
    expect(history?.[0]?.turn.status).toBe(status);
    expect(JSON.stringify(history).includes("held child output")).toBe(
      keepsOutput,
    );
  });

  test("shows an agent Claude starts as a thread under the turn's thread until it completes", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    claude.emit(sdk(taskStarted("toolu-agent", 1)));
    claude.emit(sdk(taskNotification("toolu-agent")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    const [child] = subagents.childrenOf(THREAD);
    expect(child).toMatchObject({ active: false, turnId: "turn-1" });
    expect(subagentEvents(sent)).toEqual([
      `${THREAD} turn-1 started ${child?.id}`,
      `${child?.id} active`,
      `${child?.id} idle`,
      `${THREAD} turn-1 completed ${child?.id}`,
    ]);
  });

  test("shows what an agent says in its own thread and not in the parent's turn", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    claude.emit(sdk(taskStarted("toolu-agent", 1)));
    claude.emit(
      sdk({
        type: "assistant",
        message: {
          id: "msg-sub",
          content: [
            {
              type: "tool_use",
              id: "toolu-ls",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
          stop_reason: null,
        },
        parent_tool_use_id: "toolu-agent",
      }),
    );
    claude.emit(sdk(taskNotification("toolu-agent")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    const [child] = subagents.childrenOf(THREAD);
    const commands = completedItems(sent).filter(
      (item) => item.type === "commandExecution",
    );
    expect(commands).toHaveLength(1);
    expect(
      sent.find(
        (m) =>
          m.method === "item/completed" &&
          m.params.item.type === "commandExecution",
      )?.params.threadId,
    ).toBe(child?.id);
    expect(subagents.historyOf(child?.id ?? "")).toMatchObject([
      { turn: { status: "completed" } },
    ]);
  });

  test("reports an agent that finishes after its turn ended under that turn", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    claude.emit(sdk(taskStarted("toolu-agent", 1)));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);
    claude.emit(sdk(taskNotification("toolu-agent")));
    await until(() => subagents.childrenOf(THREAD)[0]?.active === false);

    expect(subagentEvents(sent).at(-1)).toBe(
      `${THREAD} turn-1 completed ${subagents.childrenOf(THREAD)[0]?.id}`,
    );
  });

  test.each([
    {
      name: "is killed",
      ending: {
        type: "system",
        subtype: "task_updated",
        task_id: "task-toolu-agent",
        patch: { status: "killed" },
      },
      turn: { status: "interrupted" },
    },
    {
      name: "is reported done by its task",
      ending: {
        type: "system",
        subtype: "task_updated",
        task_id: "task-toolu-agent",
        patch: { status: "completed" },
      },
      turn: { status: "completed" },
    },
    {
      name: "fails",
      ending: {
        ...taskNotification("toolu-agent"),
        status: "failed",
        summary: "API error: overloaded",
      },
      turn: { status: "failed", error: { message: "API error: overloaded" } },
    },
  ])("ends an agent's thread when the agent $name", async ({
    ending,
    turn,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    claude.emit(sdk(taskStarted("toolu-agent", 1)));
    claude.emit(sdk(ending));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    const [child] = subagents.childrenOf(THREAD);
    expect(child).toMatchObject({ active: false });
    expect(subagents.historyOf(child?.id ?? "")).toMatchObject([{ turn }]);
  });

  test("ends the agents of a session that closed", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    claude.emit(sdk(taskStarted("toolu-agent", 1)));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);
    claude.fail(new Error("Claude Code process exited with code 1"));
    await until(() => subagents.childrenOf(THREAD)[0]?.active === false);

    expect(subagentEvents(sent).at(-1)).toContain("completed");
  });

  test("leaves an agent a subagent starts inside its parent agent", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, subagents } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    claude.emit(sdk(taskStarted("toolu-inner", 2)));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(subagents.childrenOf(THREAD)).toEqual([]);
    expect(subagentEvents(sent)).toEqual([]);
  });
});

describe("turns Claude starts between app turns", () => {
  test("keeps background output that arrives while a rejected rewind is being checked", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState === "idle");
    await settle();
    const gate = createGate();
    const changing = turns.changeConversation(THREAD, async () => {
      await gate.promise;
      return false;
    });
    claude.emit(sdk(INIT));
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    claude.emit(sdk(ownResult()));
    await Bun.sleep(5);
    expect(completedTurnStatuses(sent)).toHaveLength(1);
    gate.open();
    expect(await changing).toBe(false);
    await until(() => completedTurnStatuses(sent).length === 2);
    expect(completedTurns(sent)[1]).toMatchObject({
      status: "completed",
      items: [{ type: "agentMessage", text: "the agent finished" }],
    });
  });

  test("keeps a background approval pending until a rejected rewind releases the chat", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState === "idle");
    await settle();
    const gate = createGate();
    const changing = turns.changeConversation(THREAD, async () => {
      await gate.promise;
      return false;
    });
    const decision = askTool(
      claude,
      "Bash",
      { command: "ls" },
      { agentID: "agent-1" },
    );
    await Bun.sleep(5);
    gate.open();
    await changing;
    const request = await appRequest(sent);
    turns.answerRequest({ id: request.id, result: ALLOWED });
    expect(await decision).toEqual({ behavior: "allow" });
  });

  test("shows a turn Claude started on its own as a turn nobody typed", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    claude.emit(sdk(INIT));
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    claude.emit(sdk(ownResult()));
    await until(() => completedTurnStatuses(sent).length === 2);

    const own = sent.slice(sent.findIndex(isTurnStarted("turn-2")) - 1);
    expect(own.map((message) => message.method)).toEqual([
      "thread/status/changed",
      "turn/started",
      "item/started",
      "item/completed",
      "thread/tokenUsage/updated",
      "thread/status/changed",
      "turn/completed",
    ]);
    expect(completedTurns(sent)[1]).toMatchObject({
      id: "turn-2",
      status: "completed",
      items: [{ type: "agentMessage", text: "the agent finished" }],
    });
    expect(
      completedItems(own).filter((item) => item.type === "userMessage"),
    ).toEqual([]);
    expect(events).toContainEqual({ event: "claude_turn", step: "own_turn" });
    expect(claude.closes()).toBe(0);
  });

  test("asks the app about a tool Claude wants before its own turn is shown", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const decisions: ReturnType<typeof askTool>[] = [];
    const { turns, sent } = await harness([claude], {
      onSend: (message) => {
        if (isTurnStarted("turn-2")(message)) {
          decisions.push(askTool(claude, "Bash", { command: "ls" }));
        }
      },
    });
    await completeTurn(turns, sent, claude, 10);

    claude.emit(sdk(INIT));
    await until(() => decisions.length === 1);
    const request = await appRequest(sent);
    turns.answerRequest({ id: request.id, result: { decision: "accept" } });

    expect(await decisions[0]).toEqual({ behavior: "allow" });
    expect(request.params).toMatchObject({ turnId: "turn-2", command: "ls" });
  });

  test("starts a turn of Claude's own that begins right as the last turn ends", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    const [prompt] = await readPrompts(claude, 1);
    claude.emit(sdk(answer("msg-1", "started")));
    claude.emit(sdk(success([prompt?.uuid])));
    claude.emit(sdk(INIT));
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    claude.emit(sdk(ownResult()));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(completedTurns(sent)).toMatchObject([
      { id: "turn-1", items: [{ text: "started" }] },
      { id: "turn-2", items: [{ text: "the agent finished" }] },
    ]);
  });

  test("runs what the user sends during Claude's own turn after it", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);
    const prompts = claude.prompt()?.[Symbol.asyncIterator]();
    await prompts?.next();

    claude.emit(sdk(INIT));
    await until(() => startedTurns(sent).length === 2);
    turns.startTurn(turnStart(11, "next"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    claude.emit(sdk(ownResult()));
    const next = await prompts?.next();
    claude.emit(sdk(answer("msg-3", "hi")));
    claude.emit(sdk(success([next?.value?.uuid])));
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-3" });
    expect(next?.value?.message.content).toBe("next");
    expect(completedTurns(sent).slice(1)).toMatchObject([
      { id: "turn-2", items: [{ text: "the agent finished" }] },
      { id: "turn-3", items: [{ text: "hi" }] },
    ]);
  });

  test("stops Claude's own turn when the app interrupts it", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    claude.emit(sdk(INIT));
    await until(() => startedTurns(sent).length === 2);
    turns.interruptTurn(interrupt(20, "turn-2"));
    await until(() => claude.interrupts() === 1);
    claude.emit(
      sdk(ownResult({ subtype: "error_during_execution", is_error: true })),
    );
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(responseTo(sent, 20)).toEqual({ id: 20, result: {} });
    expect(completedTurnStatuses(sent)).toEqual(["completed", "interrupted"]);
    expect(claude.closes()).toBe(0);
  });

  test("leaves a background task's report alone until Claude starts a turn for it", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    claude.emit(sdk(TASKS_RUNNING));
    claude.emit(
      sdk({ ...answer("msg-sub", "working"), parent_tool_use_id: "toolu-1" }),
    );
    claude.emit(
      sdk({
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        status: "completed",
        output_file: "/tmp/task-1.output",
        summary: "done",
      }),
    );
    await until(() => claude.drained());
    await settle();

    expect(startedTurns(sent)).toHaveLength(1);
  });

  test("keeps Claude running past the idle time until its background tasks end", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await harness([claude], {
      idleSessionMs: 5,
    });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    claude.emit(sdk(TASKS_RUNNING));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);
    await Bun.sleep(30);
    expect(claude.closes()).toBe(0);
    claude.emit(sdk({ ...TASKS_RUNNING, tasks: [] }));
    await until(() => claude.closes() === 1);

    expect(events).toContainEqual({
      event: "claude_turn",
      step: "idle_closed",
    });
  });

  test("closes Claude at the idle time when only ambient tasks run", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude], { idleSessionMs: 5 });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    claude.emit(
      sdk({
        ...TASKS_RUNNING,
        tasks: [{ ...TASKS_RUNNING.tasks[0], ambient: true }],
      }),
    );
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    await until(() => claude.closes() === 1);
  });

  test("shows the rest of a turn Claude started on its own as no new turn when the app could not be shown it", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let failing = false;
    const { turns, sent } = await harness([claude], {
      files: {
        createMarker: async (path) => {
          if (!failing) return createEmptyFile(path);
          failing = false;
          return diskFull(path);
        },
      },
    });
    await completeTurn(turns, sent, claude, 10);

    failing = true;
    claude.emit(sdk(INIT));
    await until(() => completedTurnStatuses(sent).length === 2);
    claude.emit(sdk(answer("msg-2", "the agent finished")));
    claude.emit(sdk(ownResult()));
    await until(() => claude.drained());
    await settle();
    claude.emit(sdk(INIT));
    claude.emit(sdk(answer("msg-3", "another report")));
    claude.emit(sdk(ownResult()));
    await until(() => completedTurnStatuses(sent).length === 3);

    expect(completedTurns(sent).slice(1)).toMatchObject([
      { id: "turn-2", status: "failed" },
      { id: "turn-3", items: [{ text: "another report" }] },
    ]);
  });

  test("resumes on a new Claude after the session failed while no turn ran", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const next = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude, next]);
    await completeTurn(turns, sent, claude, 10);

    claude.fail(new Error("Claude Code process exited with code 1"));
    await until(() => claude.closes() === 1);
    await completeTurn(turns, sent, next, 11);

    expect(settings[1]).toMatchObject({ resume: "se-1" });
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
  });
});

describe("a Claude that stops while a turn waits to read it", () => {
  test.each<{
    name: string;
    stop: (claude: ReturnType<typeof fakeClaude>) => void;
  }>([
    { name: "ends", stop: (claude) => claude.end() },
    {
      name: "fails",
      stop: (claude) => claude.fail(new Error("socket closed")),
    },
  ])("runs the turn on a new Claude when the idle Claude $name before it", async ({
    stop,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const next = fakeClaude(SUBSCRIPTION);
    const marking = { held: false };
    const gate = createGate();
    const { turns, sent, settings } = await harness([claude, next], {
      files: {
        createMarker: async (path) => {
          if (marking.held) await gate.promise;
          return createEmptyFile(path);
        },
      },
    });
    await completeTurn(turns, sent, claude, 10);

    marking.held = true;
    turns.startTurn(turnStart(11, "next"), undefined);
    stop(claude);
    await until(() => claude.closes() > 0);
    gate.open();
    await until(() => next.prompted());
    next.emit(sdk(answer("msg-2", "hi")));
    next.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(completedTurns(sent)[1]).toMatchObject({
      id: "turn-2",
      status: "completed",
      items: [{ text: "hi" }],
    });
    expect(await firstPrompt(next.prompt())).toBe("next");
    expect(settings[1]).toMatchObject({ resume: "se-1" });
  });
});

describe("thread tools", () => {
  test("give each Claude session its own thread tool server and allowed tools", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings, links } = await harness([first, second]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.prompted());
    first.fail(new Error("socket closed"));
    await until(() => turnCompleted(sent) !== undefined);
    await completeTurn(turns, sent, second, 11);

    expect(links).toEqual([THREAD, THREAD]);
    expect(settings[0]?.allowedTools).toEqual(ALLOWED_TOOLS);
    expect(Object.keys(settings[0]?.toolServers ?? {})).toEqual(["codex_link"]);
    expect(settings[1]?.toolServers?.codex_link).not.toBe(
      settings[0]?.toolServers?.codex_link,
    );
  });

  test("stop taking writes when the turn is stopped", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, gates } = await harness([claude]);
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    expect(gates).toEqual(["accept"]);

    turns.interruptTurn(interrupt(20, "turn-1"));

    expect(gates).toEqual(["accept", "stop"]);
  });

  test("stop taking writes when a turn finishes and take them again for the next turn", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, gates } = await harness([claude]);

    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState === "idle");
    expect(gates).toEqual(["accept", "stop"]);
    await completeTurn(turns, sent, claude, 11);
    await until(() => gates.length === 4);

    expect(gates).toEqual(["accept", "stop", "accept", "stop"]);
  });
});

describe("idle Claude sessions", () => {
  test("close after the idle time and resume the conversation in auto mode on the next turn", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings, events } = await harness([first, second], {
      idleSessionMs: 5,
    });

    await completeTurn(turns, sent, first, 10);
    await until(() => first.closes() === 1);
    await completeTurn(turns, sent, second, 11);

    expect(events).toContainEqual({
      event: "claude_turn",
      step: "idle_closed",
    });
    expect(first.options().permissionMode).toBe("auto");
    expect(second.options()).toMatchObject({
      permissionMode: "auto",
      resume: "se-1",
    });
    expect(second.modes()).toEqual(["auto"]);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
  });

  test("stay open for a turn that starts before the idle time ends", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, settings } = await harness([claude], {
      idleSessionMs: 40,
    });
    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState === "idle");
    await Bun.sleep(5);

    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    await Bun.sleep(60);
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(claude.closes()).toBe(0);
    expect(settings).toHaveLength(1);
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
  });

  test("stay open for a turn that waited behind the one that ended", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude], { idleSessionMs: 5 });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.startTurn(turnStart(11, "again"), undefined);
    claude.emit(sdk(success()));
    await until(() => responseTo(sent, 11) !== undefined);
    await settle();

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(claude.closes()).toBe(0);
  });

  test("stay open when Claude never reported a session id to resume", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude], {
      idleSessionMs: 5,
    });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    claude.emit(sdk({ ...success(), session_id: undefined }));
    await until(() => turnCompleted(sent) !== undefined);
    await settle();
    await completeTurn(turns, sent, claude, 11);

    expect(claude.closes()).toBe(0);
    expect(settings).toHaveLength(1);
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
  });
});

type Runtime = Awaited<ReturnType<typeof harness>>["runtime"];

type Started = Awaited<ReturnType<typeof harness>>;

type Gate = ReturnType<typeof createGate>;

const TASKS_RUNNING = {
  type: "system",
  subtype: "background_tasks_changed",
  tasks: [{ task_id: "task-1", task_type: "local_agent", description: "x" }],
};

const taskNotification = (toolUseId: string) => ({
  type: "system",
  subtype: "task_notification",
  task_id: `task-${toolUseId}`,
  tool_use_id: toolUseId,
  status: "completed",
  output_file: "/fixture/task.output",
  summary: "done",
});

// Each subagent activity item the app got, once at its completion, and each status change of a subagent's thread.
const subagentEvents = (sent: Sent[]) =>
  sent.flatMap((message) => {
    if (
      message.method === "item/completed" &&
      message.params.item.type === "subAgentActivity"
    ) {
      const { params } = message;
      return [
        `${params.threadId} ${params.turnId} ${params.item.kind} ${params.item.agentThreadId}`,
      ];
    }
    if (
      message.method === "thread/status/changed" &&
      message.params.threadId !== THREAD
    ) {
      return [`${message.params.threadId} ${message.params.status.type}`];
    }
    return [];
  });

const answerAndComplete = async (
  claude: FakeClaude,
  sent: Sent[],
  messageId: string,
  completed: number,
) => {
  claude.emit(sdk(answer(messageId, "reply")));
  await until(() => claude.drained());
  claude.emit(sdk(success()));
  await until(() => completedTurnStatuses(sent).length === completed);
};
