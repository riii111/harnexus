import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type InferErr, Result } from "better-result";
import { SUBSCRIPTION_CONNECTION } from "../infra/claude/connection.ts";
import type { ClaudeSessionSettings } from "../infra/claude/session.ts";
import { fakeClaude } from "../infra/claude/testing/fake-claude.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import type { openThreadStore } from "../infra/thread-store.ts";
import {
  FileRemoveFailed,
  removeFile,
  writeFileAtomic,
} from "../runtime/fs.boundary.ts";
import type { createTurnController } from "./controller.ts";
import {
  answer,
  appRequest,
  askTool,
  completedItems,
  completedTurnStatuses,
  completedTurns,
  completeTurn,
  createGate,
  delegation,
  dir,
  diskFull,
  firstPrompt,
  harness,
  interrupt,
  MODEL,
  OTHER_DIR,
  OTHER_MODEL,
  OTHER_THREAD,
  OUTCOME_UNKNOWN,
  promptsUntil,
  REFUSED,
  readPrompts,
  reply,
  resolvedRequests,
  responseTo,
  restartedWithUnknownOutcome,
  result,
  type Sent,
  SUBSCRIPTION,
  sdk,
  settle,
  startedTurns,
  success,
  THREAD,
  turnCompleted,
  turnStart,
  twoWorkers,
  until,
  useTempDir,
  VERTEX,
  VERTEX_ACCOUNT,
  VERTEX_MODEL,
  withEffort,
  withMessageId,
} from "./testing/harness.ts";

useTempDir();

describe("turn/start on a Claude thread", () => {
  test("answers with the turn, sends the prompt, completes from Claude's result and logs it as finished", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, settings, events } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    expect(await firstPrompt(claude.prompt())).toBe("hello");
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(sent.slice(0, 3).map((m) => m.method ?? "response")).toEqual([
      "thread/status/changed",
      "turn/started",
      "response",
    ]);
    expect(responseTo(sent, 10)?.result.turn).toMatchObject({
      id: "turn-1",
      status: "inProgress",
    });
    expect(settings[0]).toMatchObject({ cwd: dir, model: MODEL });
    expect(turnCompleted(sent)).toMatchObject({ status: "completed" });
    await until(() => store.get(THREAD)?.runState === "idle");
    expect(store.get(THREAD)).toMatchObject({
      sessionId: "se-1",
      worktree: dir,
      model: MODEL,
    });
    expect(
      events.filter(
        (event) => event.event === "claude_turn" && event.step === "finished",
      ),
    ).toEqual([
      {
        event: "claude_turn",
        step: "finished",
        status: "completed",
        error: null,
      },
    ]);
  });

  test("names the running turn and its prompt's record until the turn ends", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    await firstPrompt(claude.prompt());
    const running = turns.liveTurnOf(THREAD);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(running).toMatchObject({ turnId: "turn-1" });
    expect(typeof running?.record).toBe("string");
    expect(turns.liveTurnOf(THREAD)).toBeNull();
  });

  test("names a turn queued behind one that ended as running until it starts", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const gap: unknown[] = [];
    let readGap = () => {};
    const { turns, sent } = await harness([claude], {
      onSend: (message) => {
        if (message.method === "turn/completed") readGap();
      },
    });
    readGap = () => gap.push(turns.liveTurnOf(THREAD));

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => gap.length > 0);

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(gap).toEqual([
      { turnId: "turn-2", record: null, startedAtMs: expect.any(Number) },
    ]);
  });

  test("accepts the next turn sent while the app receives turn/completed", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let startNext = () => {};
    const { turns, sent } = await harness([claude], {
      onSend: (message) => {
        if (message.method === "turn/completed") startNext();
      },
    });
    startNext = () => turns.startTurn(turnStart(11, "again"), undefined);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => responseTo(sent, 11) !== undefined);

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
  });

  test("fails the turn when the login is not a subscription", async () => {
    const claude = fakeClaude({ apiProvider: "bedrock" });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => turnCompleted(sent) !== undefined);

    expect(responseTo(sent, 10)?.result).toBeDefined();
    expect(turnCompleted(sent)).toMatchObject({ status: "failed" });
  });

  test.each<{
    name: string;
    options: NonNullable<Parameters<typeof fakeClaude>[1]>;
    request: () => ReturnType<typeof turnStart>;
    tag: string;
  }>([
    {
      name: "the mode",
      options: { permissionModeError: new Error("no control channel") },
      request: () => turnStart(10, "hello"),
      tag: "ClaudePermissionModeFailed",
    },
    {
      name: "the effort",
      options: { effortError: new Error("no control channel") },
      request: () => withEffort(turnStart(10, "hello"), "high"),
      tag: "ClaudeEffortFailed",
    },
  ])("fails the turn without sending the prompt when Claude refuses $name", async ({
    options,
    request,
    tag,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION, options);
    const { turns, sent, events } = await harness([claude]);

    turns.startTurn(request(), undefined);
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "failed" });
    expect(events).toContainEqual(
      expect.objectContaining({ step: "finished", error: tag }),
    );
    expect(claude.closes()).toBe(1);
    expect(await claude.prompts()).toEqual([]);
  });

  test("resumes the session after the stream fails", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.prompted());
    first.emit(sdk(answer("msg-1", "partial")));
    first.fail(new Error("socket closed"));
    await until(() => turnCompleted(sent) !== undefined);
    await completeTurn(turns, sent, second, 11);

    expect(completedTurnStatuses(sent)).toEqual(["failed", "completed"]);
    expect(first.closes()).toBe(1);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
  });
});

describe("continuing a rewound conversation", () => {
  test.each([
    {
      name: "a retained reply",
      at: "kept-reply",
      expected: { resume: "se-1", forkSession: true, resumeAt: "kept-reply" },
    },
    { name: "an empty history", at: null, expected: {} },
  ])("starts a separate session after rewinding to $name", async ({
    at,
    expected,
  }) => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, settings, runtime } = await harness([
      first,
      second,
    ]);
    await completeTurn(turns, sent, first, 10);
    const saved = await store.setRewind(THREAD, { sessionId: "se-1", at });
    expect(saved.isOk()).toBe(true);
    runtime.closeSession(THREAD);
    turns.startTurn(
      withMessageId(turnStart(11, "edited prompt"), "edited-message"),
      undefined,
    );
    await until(() => second.started());
    expect(await firstPrompt(second.prompt())).toBe("edited prompt");
    second.emit(sdk({ ...success(), session_id: "se-2" }));
    await until(() => store.get(THREAD)?.runState === "idle");
    expect({
      resume: settings[1]?.resume,
      forkSession: settings[1]?.forkSession,
      resumeAt: settings[1]?.resumeAt,
    }).toEqual(
      at === null
        ? { resume: undefined, forkSession: undefined, resumeAt: undefined }
        : expected,
    );
    expect(store.get(THREAD)?.sessionId).toBe("se-2");
    expect(store.get(THREAD)?.rewind).toBeUndefined();
    expect(first.closes()).toBe(1);
  });

  test("blocks new turns while a conversation change is being saved", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([first]);
    const gate = createGate();
    const changing = turns.changeConversation(THREAD, async () => {
      await gate.promise;
      return true;
    });
    turns.startTurn(turnStart(10, "race"), undefined);
    expect(responseTo(sent, 10)?.error.message).toBe(
      "the Claude thread cannot start a turn",
    );
    expect(first.started()).toBe(false);
    gate.open();
    expect(await changing).toBe(true);
    await completeTurn(turns, sent, first, 11);
    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
  });
});

describe("a thread whose last turn has an unknown outcome", () => {
  test("shows the unknown outcome and runs the first new user message while checking the current state", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let undecided = true;
    const { turns, sent, store, events } = await harness([first, second], {
      unsettledWrite: () => undecided,
    });
    await completeTurn(turns, sent, first, 10);
    await until(() => store.get(THREAD)?.runState === "outcomeUnknown");
    undecided = false;

    turns.startTurn(withMessageId(turnStart(11, "go on"), "m-1"), undefined);
    await until(() => second.prompted());
    const prompt = await firstPrompt(second.prompt());
    expect(prompt).toEqual([
      { type: "text", text: "go on" },
      { type: "text", text: expect.stringContaining("<harnexus_recovery>") },
    ]);
    expect(completedItems(sent).at(-1)).toMatchObject({
      type: "agentMessage",
      phase: "commentary",
      text: expect.stringContaining(
        "Changes or messages may already have been applied",
      ),
    });
    expect(
      completedItems(sent)
        .filter((item) => item.type === "userMessage")
        .at(-1),
    ).toMatchObject({
      content: [{ type: "text", text: "go on", text_elements: [] }],
    });
    second.emit(sdk(success()));
    await until(() => store.get(THREAD)?.runState === "idle");

    expect(responseTo(sent, 11)?.error).toBeUndefined();
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "outcome_unknown",
    });
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "outcome_cleared",
    });
  });

  test.each([
    { name: "Composer submission", trigger: "composer" },
    { name: "queued user message", trigger: "composer_queue" },
    {
      name: "manually started queued message",
      trigger: "composer_queue_run_now",
    },
  ])("resumes the saved Claude conversation on the first $name after a restart", async ({
    trigger,
  }) => {
    const second = fakeClaude(SUBSCRIPTION);
    const after = await restartedWithUnknownOutcome([second]);

    const request = withMessageId(turnStart(11, "continue"), "m-1");
    after.turns.startTurn(
      { ...request, params: { ...request.params, turnTrigger: trigger } },
      undefined,
    );
    await until(() => second.prompted());
    second.emit(sdk(success()));
    await until(() => after.store.get(THREAD)?.runState === "idle");

    expect(responseTo(after.sent, 11)?.error).toBeUndefined();
    expect(responseTo(after.sent, 11)?.result.turn.id).toBeDefined();
    expect(completedTurnStatuses(after.sent)).toEqual(["completed"]);
    expect(after.settings[0]).toMatchObject({ resume: "se-1" });
  });

  test.each([
    {
      name: "another thread's message",
      request: () => withMessageId(reply(12, THREAD, NEW_REVIEWER), "m-2"),
    },
    {
      name: "an automatic safety-buffer retry with a fresh client id",
      request: () => {
        const retry = withMessageId(turnStart(12, "again"), "m-2");
        return {
          ...retry,
          params: { ...retry.params, turnTrigger: "safety_buffer_retry" },
        };
      },
    },
    {
      name: "a message without a client message id",
      request: () => turnStart(12, "again"),
    },
    ...[
      { name: "automatic App-update resume", trigger: "app_update_resume" },
      {
        name: "automatic interrupted-task resume",
        trigger: "resume_interrupted_task",
      },
      {
        name: "a heartbeat automation",
        trigger: "automation_heartbeat_fixture",
      },
      { name: "a submission with missing origin metadata", trigger: undefined },
    ].map(({ name, trigger }) => ({
      name,
      request: () => {
        const request = withMessageId(turnStart(12, "again"), "m-2");
        return {
          ...request,
          params: { ...request.params, turnTrigger: trigger },
        };
      },
    })),
  ])("does not take $name as the user's decision to continue", async ({
    request,
  }) => {
    const second = fakeClaude(SUBSCRIPTION);
    const after = await restartedWithUnknownOutcome([second]);
    after.turns.startTurn(request(), undefined);
    await until(() => responseTo(after.sent, 12) !== undefined);
    expect(after.store.get(THREAD)?.runState).toBe("outcomeUnknown");
    expect(second.started()).toBe(false);
    await completeTurn(after.turns, after.sent, second, 13, "m-3");

    expect(responseTo(after.sent, 12)?.error.message).toBe(OUTCOME_UNKNOWN);
    expect(after.settings).toHaveLength(1);
    expect(completedTurnStatuses(after.sent)).toEqual(["completed"]);
  });

  test("refuses an already delivered user message after the interrupted conversation is reloaded", async () => {
    const second = fakeClaude(SUBSCRIPTION);
    const after = await restartedWithUnknownOutcome([second]);

    await completeTurn(after.turns, after.sent, second, 11, "m-1");
    await until(() => after.store.get(THREAD)?.runState === "idle");
    const reloaded = await harness([]);
    reloaded.turns.startTurn(
      withMessageId(turnStart(12, "again"), "m-1"),
      undefined,
    );
    expect(responseTo(reloaded.sent, 12)).toEqual(DUPLICATE(12));
    expect(reloaded.settings).toHaveLength(0);
  });

  test("blocks a retry of the original interrupted message and accepts a new instruction", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const before = await harness([first], { unsettledWrite: () => true });
    await completeTurn(before.turns, before.sent, first, 10, "original-id");
    await until(() => before.store.get(THREAD)?.runState === "outcomeUnknown");
    const second = fakeClaude(SUBSCRIPTION);
    const after = await harness([second]);
    after.turns.startTurn(
      withMessageId(turnStart(11, "again"), "original-id"),
      undefined,
    );
    await until(() => responseTo(after.sent, 11) !== undefined);
    expect(responseTo(after.sent, 11)).toEqual(DUPLICATE(11));
    expect(second.started()).toBe(false);
    expect(after.store.get(THREAD)?.runState).toBe("outcomeUnknown");
    await completeTurn(after.turns, after.sent, second, 12, "new-id");
    expect(completedTurnStatuses(after.sent)).toEqual(["completed"]);
  });

  test("continues on a new Claude session whose thread tools write again after a write whose answer was lost", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let lost = true;
    const { turns, sent, store, settings, toolCalls } = await harness(
      [first, second],
      {
        linkRequest: async () =>
          lost ? Result.err(UNANSWERED) : Result.ok(TOOL_ANSWER),
      },
    );
    turns.startTurn(turnStart(10, "ask the reviewer"), undefined);
    await until(() => first.started());
    await store.addReviewer(THREAD, NEW_REVIEWER);
    const lostSend = await messageReviewer(settings[0]);
    first.emit(sdk(success()));
    await until(() => store.get(THREAD)?.runState === "outcomeUnknown");
    lost = false;

    turns.startTurn(
      withMessageId(turnStart(11, "what happened?"), "m-1"),
      undefined,
    );
    await until(() => second.started());
    const resent = await messageReviewer(settings[1]);
    second.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);
    await until(() => store.get(THREAD)?.runState !== "running");

    expect(lostSend.isError).toBe(true);
    expect(responseTo(sent, 11)?.error).toBeUndefined();
    expect(first.closes()).toBe(1);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
    expect(resent.isError).toBeFalsy();
    expect(toolCalls).toHaveLength(2);
    expect(store.get(THREAD)?.runState).toBe("idle");
  });

  test("continues on a new Claude session after a turn stopped mid-write, which a late answer neither breaks nor sends again", async () => {
    const first = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const second = fakeClaude(SUBSCRIPTION);
    const late = createGate();
    const { turns, sent, store, settings, toolCalls } = await harness(
      [first, second],
      {
        linkRequest: async () => {
          if (toolCalls.length === 1) await late.promise;
          return Result.ok(TOOL_ANSWER);
        },
      },
    );
    turns.startTurn(turnStart(10, "ask the reviewer"), undefined);
    await until(() => first.started());
    await store.addReviewer(THREAD, NEW_REVIEWER);
    const waiting = messageReviewer(settings[0]);
    await until(() => toolCalls.length === 1);
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => first.interrupts() === 1);
    first.emit(
      sdk(result({ subtype: "error_during_execution", is_error: true })),
    );
    await until(() => store.get(THREAD)?.runState === "outcomeUnknown");

    turns.startTurn(
      withMessageId(turnStart(11, "what happened?"), "m-1"),
      undefined,
    );
    await until(() => second.started());
    late.open();
    await waiting;
    const next = await messageReviewer(settings[1]);
    second.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);
    await until(() => store.get(THREAD)?.runState !== "running");

    expect(responseTo(sent, 11)?.error).toBeUndefined();
    expect(first.closes()).toBe(1);
    expect(second.closes()).toBe(0);
    expect(next.isError).toBeFalsy();
    expect(toolCalls).toHaveLength(2);
    expect(completedTurnStatuses(sent)).toEqual(["interrupted", "completed"]);
    expect(store.get(THREAD)?.runState).toBe("idle");
  });

  test("recovers a queued user instruction after the preceding turn leaves an unknown outcome", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let undecided = true;
    const { turns, sent, store } = await harness([first, second], {
      unsettledWrite: () => undecided,
    });
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.started());
    turns.startTurn(withMessageId(turnStart(11, "reply"), "m-1"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    first.emit(sdk(success()));
    await until(() => second.prompted());
    undecided = false;
    second.emit(sdk(success()));
    await until(() => store.get(THREAD)?.runState === "idle");

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(completedTurns(sent)[1]).toMatchObject({
      id: "turn-2",
      status: "completed",
    });
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
    expect(
      sent
        .filter((m) => m.method === "thread/status/changed")
        .map((m) => m.params.status.type),
    ).toEqual(["active", "idle", "active", "idle"]);
  });

  test("keeps the durable unknown outcome if the resumed turn completes but its marker cannot be removed", async () => {
    const second = fakeClaude(SUBSCRIPTION);
    const after = await restartedWithUnknownOutcome([second], {
      files: {
        removeMarker: async (path) =>
          Result.err(
            new FileRemoveFailed({ path, cause: null, message: "read-only" }),
          ),
      },
    });

    await completeTurn(after.turns, after.sent, second, 11, "m-1");
    await until(() => after.store.get(THREAD)?.runState === "outcomeUnknown");
    expect(completedTurnStatuses(after.sent)).toEqual(["completed"]);
    expect(after.events).toContainEqual({
      event: "claude_turn",
      step: "run_state_not_saved",
      error: "RunStateNotSaved",
    });
    expect(after.store.get(THREAD)?.runState).toBe("outcomeUnknown");
    const reloaded = await harness([]);
    expect(reloaded.store.get(THREAD)?.runState).toBe("outcomeUnknown");
  });

  test("keeps the recovery context across a message-save failure and continues when the same input can be saved", async () => {
    const second = fakeClaude(SUBSCRIPTION);
    let fail = true;
    const after = await restartedWithUnknownOutcome([second], {
      files: {
        writeState: (path, content) =>
          fail ? diskFull(path) : writeFileAtomic(path, content),
      },
    });
    after.turns.startTurn(
      withMessageId(turnStart(11, "go on"), "m-1"),
      undefined,
    );
    await until(() => responseTo(after.sent, 11) !== undefined);
    expect(responseTo(after.sent, 11)?.error.message).toBe(
      "the message id could not be saved, so the message was not run to avoid running it twice",
    );
    expect(second.started()).toBe(false);
    await until(() => after.store.get(THREAD)?.runState === "outcomeUnknown");
    expect((await harness([])).store.get(THREAD)?.runState).toBe(
      "outcomeUnknown",
    );
    fail = false;
    await completeTurn(after.turns, after.sent, second, 12, "m-1");
    await until(() => after.store.get(THREAD)?.runState === "idle");
    expect(await firstPrompt(second.prompt())).toEqual([
      { type: "text", text: "prompt 12" },
      { type: "text", text: expect.stringContaining("<harnexus_recovery>") },
    ]);
  });

  test("keeps the unknown outcome when a queued user instruction is stopped before it starts", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store } = await harness([first, second], {
      unsettledWrite: () => true,
    });
    turns.startTurn(turnStart(10, "work"), undefined);
    await until(() => first.prompted());
    turns.startTurn(
      withMessageId(turnStart(11, "go on"), "queued-id"),
      undefined,
    );
    const turnId = responseTo(sent, 11).result.turn.id;
    turns.interruptTurn(interrupt(20, turnId));
    expect(responseTo(sent, 20)?.result).toEqual({});
    first.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);
    expect(store.get(THREAD)?.runState).toBe("outcomeUnknown");
    expect(second.started()).toBe(false);
    expect(completedTurns(sent)[1]).toMatchObject({
      status: "failed",
      error: { message: OUTCOME_UNKNOWN },
    });
  });
});

describe("keeping the thread on the server's disk", () => {
  test("asks the server once per thread while the bridge runs", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, materialized } = await harness([claude]);

    await completeTurn(turns, sent, claude, 10);
    await completeTurn(turns, sent, claude, 11);

    expect(materialized).toEqual([THREAD]);
  });

  test("asks again at the next turn after a failure and logs it", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, materialized, events, store } = await harness(
      [claude],
      { materializeFailures: 1 },
    );

    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState === "idle");
    await completeTurn(turns, sent, claude, 11);

    expect(materialized).toEqual([THREAD, THREAD]);
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "thread_not_materialized",
      error: "ServerRequestUnanswered",
    });
  });
});

describe("turn/interrupt", () => {
  test("replies before the turn completes as interrupted", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => claude.interrupts() === 1);
    claude.emit(
      sdk(result({ subtype: "error_during_execution", is_error: true })),
    );
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
    const reply = sent.findIndex((m) => m.id === 20);
    const completed = sent.findIndex((m) => m.method === "turn/completed");
    expect(sent[reply]).toEqual({ id: 20, result: {} });
    expect(reply).toBeLessThan(completed);
    expect(claude.closes()).toBe(0);
  });

  test.each<{ name: string; options: Parameters<typeof fakeClaude>[1] }>([
    { name: "a send still queued", options: { stillQueued: ["uuid-queued"] } },
    { name: "no receipt from an older CLI", options: {} },
    {
      name: "an error",
      options: { interruptError: new Error("no control channel") },
    },
  ])("closes Claude after an interrupt that answers with $name", async ({
    options,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION, options);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
    expect(claude.closes()).toBe(1);
  });

  test("waits for a late interrupt receipt before the next turn reuses the session", async () => {
    const gate = createGate();
    const first = fakeClaude(SUBSCRIPTION, {
      stillQueued: ["uuid-queued"],
      interruptAnswered: gate.promise,
    });
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.prompted());
    first.emit(sdk(answer("msg-1", "partial")));
    turns.interruptTurn(interrupt(20, "turn-1"));
    first.emit(
      sdk(result({ subtype: "error_during_execution", is_error: true })),
    );
    await until(() => turnCompleted(sent) !== undefined);
    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    expect(settings).toHaveLength(1);
    gate.open();
    await until(() => second.started());

    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
    expect(first.closes()).toBe(1);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
  });

  test("stops a turn waiting on an earlier interrupt without asking Claude again", async () => {
    const gate = createGate();
    const first = fakeClaude(SUBSCRIPTION, {
      stillQueued: ["uuid-queued"],
      interruptAnswered: gate.promise,
    });
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second]);
    await interruptBeforeReceipt(turns, sent, first);

    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    turns.interruptTurn(interrupt(21, "turn-2"));
    gate.open();
    await until(() => completedTurnStatuses(sent).length === 2);
    await completeTurn(turns, sent, second, 12);

    expect(responseTo(sent, 21)).toEqual({ id: 21, result: {} });
    expect(first.interrupts()).toBe(1);
    expect(completedTurnStatuses(sent)).toEqual([
      "interrupted",
      "interrupted",
      "completed",
    ]);
    expect(settings).toHaveLength(2);
  });

  test("starts no Claude for a waiting turn once the bridge is closing", async () => {
    const gate = createGate();
    const first = fakeClaude(SUBSCRIPTION, {
      stillQueued: ["uuid-queued"],
      interruptAnswered: gate.promise,
    });
    const { turns, sent, settings } = await harness([first]);
    await interruptBeforeReceipt(turns, sent, first);

    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    turns.closeAll();
    gate.open();
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(completedTurnStatuses(sent)).toEqual(["interrupted", "failed"]);
    expect(settings).toHaveLength(1);
  });

  test("keeps an interrupt accepted while Claude was starting", async () => {
    const claude = fakeClaude({ apiProvider: "bedrock" });
    let start = () => {};
    const beforeStart = new Promise<void>((resolve) => {
      start = resolve;
    });
    const { turns, sent } = await harness([claude], { beforeStart });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    turns.interruptTurn(interrupt(20, "turn-1"));
    start();
    await until(() => turnCompleted(sent) !== undefined);

    expect(responseTo(sent, 20)).toEqual({ id: 20, result: {} });
    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
  });

  test("refuses a turn that already completed", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);
    turns.interruptTurn(interrupt(20, "turn-1"));

    expect(responseTo(sent, 20)?.error).toBeDefined();
    expect(claude.interrupts()).toBe(0);
  });

  test("asks Claude once when the stop is sent twice", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => claude.interrupts() === 1);
    await Bun.sleep(0);
    turns.interruptTurn(interrupt(21, "turn-1"));
    await until(() => responseTo(sent, 21) !== undefined);

    expect(responseTo(sent, 21)).toEqual({ id: 21, result: {} });
    expect(claude.interrupts()).toBe(1);
  });

  test("refuses a turn id that is not running", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.interruptTurn(interrupt(20, "turn-9"));

    expect(responseTo(sent, 20)?.error).toBeDefined();
    expect(claude.interrupts()).toBe(0);
  });
});

describe("model changes", () => {
  test("restart Claude on the new model at the next turn and resume the conversation at the same effort", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings, store } = await harness([first, second]);

    await completeTurn(turns, sent, first, 10, undefined, "xhigh");
    turns.changeModel(THREAD, OTHER_MODEL);
    await completeTurn(turns, sent, second, 11);

    expect(first.closes()).toBe(1);
    expect(settings[1]).toMatchObject({ model: OTHER_MODEL, resume: "se-1" });
    expect(first.efforts()).toEqual(["xhigh"]);
    expect(second.efforts()).toEqual(["xhigh"]);
    expect(turns.threadOf(THREAD)?.model).toBe(OTHER_MODEL);
    await until(() => store.get(THREAD)?.model === OTHER_MODEL);
  });

  test("take the model a turn/start names from that turn", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second]);
    await completeTurn(turns, sent, first, 10);

    const request = turnStart(11, "again");
    turns.startTurn(
      { ...request, params: { ...request.params, model: OTHER_MODEL } },
      undefined,
    );
    await until(() => second.started());

    expect(settings[1]).toMatchObject({ model: OTHER_MODEL, resume: "se-1" });
  });

  test("leave a turn accepted before the change on its model while it waits for an earlier stop", async () => {
    const gate = createGate();
    const first = fakeClaude(SUBSCRIPTION, {
      stillQueued: ["uuid-queued"],
      interruptAnswered: gate.promise,
    });
    const second = fakeClaude(SUBSCRIPTION);
    const third = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second, third]);
    await interruptBeforeReceipt(turns, sent, first);

    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    turns.changeModel(THREAD, OTHER_MODEL);
    gate.open();
    await until(() => second.prompted());
    second.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);
    await completeTurn(turns, sent, third, 12);

    expect(settings.map((session) => session.model)).toEqual([
      MODEL,
      MODEL,
      OTHER_MODEL,
    ]);
  });

  test("save a model picked while the thread's first turn registers it", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const firstWrite = createGate();
    let writes = 0;
    const { turns, store } = await harness([claude], {
      files: {
        writeState: async (target, content) => {
          if (++writes === 1) await firstWrite.promise;
          return writeFileAtomic(target, content);
        },
      },
    });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => writes === 1);
    turns.changeModel(THREAD, OTHER_MODEL);
    firstWrite.open();
    await until(() => store.get(THREAD)?.model === OTHER_MODEL);

    expect(turns.threadOf(THREAD)?.model).toBe(OTHER_MODEL);
  });

  test("run a turn that lost the race to register the thread on the model it asked for", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second], {
      adopt: false,
    });
    const request = turnStart(10, "hello");
    const withModel = (id: number, model: string) => ({
      ...request,
      id,
      params: { ...request.params, model, cwd: dir },
    });

    turns.startTurn(withModel(10, MODEL), undefined);
    turns.startTurn(withModel(11, OTHER_MODEL), undefined);
    await until(() => first.prompted());
    first.emit(sdk(success()));
    await until(() => second.started());

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(settings.map((session) => session.model)).toEqual([
      MODEL,
      OTHER_MODEL,
    ]);
  });

  test("leave the running turn on its model", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.changeModel(THREAD, OTHER_MODEL);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "completed" });
    expect(claude.closes()).toBe(0);
    expect(settings).toHaveLength(1);
  });

  test("keep a model the store failed to save while the bridge runs", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let writes = 0;
    const { turns, sent, settings, events } = await harness([first, second], {
      files: {
        writeState: async (target, content) =>
          ++writes <= 2 ? writeFileAtomic(target, content) : diskFull(target),
      },
    });

    await completeTurn(turns, sent, first, 10);
    turns.changeModel(THREAD, OTHER_MODEL);
    await until(() => events.some((event) => event.step === "model_not_saved"));
    await completeTurn(turns, sent, second, 11);

    expect(events).toContainEqual({
      event: "claude_turn",
      step: "model_not_saved",
      error: "StatePersistFailed",
    });
    expect(settings[1]).toMatchObject({ model: OTHER_MODEL });
  });
});

describe("refused requests", () => {
  test.each([
    {
      name: "audio input",
      override: { input: [{ type: "localAudio", path: "/tmp/note.wav" }] },
    },
    {
      name: "an image held only by a server",
      override: {
        input: [{ type: "image", url: "https://example.com/shot.png" }],
      },
    },
    { name: "a Codex model", override: { model: "gpt-fixture" } },
    {
      name: "a Codex model in the collaboration mode alone",
      override: {
        collaborationMode: { mode: "default", settings: { model: "gpt-x" } },
      },
    },
    { name: "another working directory", override: { cwd: "/elsewhere" } },
  ])("refuses $name without starting Claude or asking the server", async ({
    override,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, materialized } = await harness([claude]);

    const request = turnStart(10, "hello");
    turns.startTurn(
      { ...request, params: { ...request.params, ...override } },
      undefined,
    );
    await settle();

    expect(sent).toEqual([REFUSED(10)]);
    expect(claude.started()).toBe(false);
    expect(materialized).toEqual([]);
  });

  test("answers a rejected request with the given message", async () => {
    const { turns, sent } = await harness([]);

    turns.reject({ id: 12 }, "not yet");

    expect(sent).toEqual([
      { id: 12, error: { code: -32600, message: "not yet" } },
    ]);
  });

  test("fails a turn asking for another directory that lost the race to register the thread", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude], {
      adopt: false,
    });
    const request = turnStart(10, "hello");
    const first = {
      ...request,
      params: { ...request.params, model: MODEL, cwd: dir },
    };

    turns.startTurn(first, undefined);
    turns.startTurn(
      { ...first, id: 11, params: { ...first.params, cwd: "/elsewhere" } },
      undefined,
    );
    await until(() => completedOn(sent, THREAD) !== undefined);
    await until(() => claude.started());

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(completedOn(sent, THREAD)).toMatchObject({
      id: "turn-2",
      status: "failed",
      error: {
        message:
          "changing the working directory of a Claude thread is not supported",
      },
    });
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ cwd: dir });
  });

  test("switches a Codex thread to Claude only when its directory is known", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude], {
      adopt: false,
    });
    const request = turnStart(10, "hello");
    const withModel = {
      ...request,
      params: { ...request.params, model: MODEL },
    };

    turns.startTurn(withModel, undefined);
    turns.startTurn({ ...withModel, id: 11 }, dir);
    await until(() => claude.started());

    expect(responseTo(sent, 10)?.error).toBeDefined();
    expect(settings[0]).toMatchObject({ cwd: dir, model: MODEL });
  });
});

describe("turn/start arriving on a busy thread", () => {
  test("answers at once, waits for the running turn and then continues the same Claude session", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings, events } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    turns.startTurn(turnStart(11, "reply"), undefined);
    await settle();
    expect(responseTo(sent, 11)?.result.turn).toMatchObject({
      id: "turn-2",
      status: "inProgress",
    });
    expect(startedTurns(sent)).toEqual(["turn-1"]);
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => startedTurns(sent).length === 2);
    claude.emit(sdk(answer("msg-2", "ok")));
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(sent.filter((m) => m.id === 11)).toHaveLength(1);
    expect(startedTurns(sent)).toEqual(["turn-1", "turn-2"]);
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
    expect(await promptsUntil(claude, 2)).toEqual(["hello", "reply"]);
    expect(settings).toHaveLength(1);
    expect(events).toContainEqual({ event: "claude_turn", step: "queued" });
  });

  test("stops an answered waiting turn before it reaches Claude and leaves the running turn's prompt open", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    const decision = askTool(claude, "Bash", { command: "ls" });
    const request = await appRequest(sent);
    turns.startTurn(turnStart(11, "reply"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);

    turns.interruptTurn(interrupt(21, "turn-2"));

    expect(responseTo(sent, 21)).toEqual({ id: 21, result: {} });
    expect(resolvedRequests(sent)).toEqual([]);
    expect(claude.interrupts()).toBe(0);
    turns.answerRequest({ id: request.id, result: { decision: "accept" } });
    expect(await decision).toEqual({ behavior: "allow" });
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);
    expect(completedTurnStatuses(sent)).toEqual(["completed", "interrupted"]);
    await completeTurn(turns, sent, claude, 12);
    expect(await promptsUntil(claude, 2)).toEqual(["hello", "prompt 12"]);
  });

  test("stops a turn answered while the turn before it is still being cleared up", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const gate = createGate();
    let holdCleanup = false;
    const { turns, sent } = await harness([claude], {
      files: {
        removeMarker: async (target) => {
          if (holdCleanup) await gate.promise;
          return removeFile(target);
        },
      },
    });
    holdCleanup = true;
    await completeTurn(turns, sent, claude, 10);
    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);

    turns.interruptTurn(interrupt(21, "turn-2"));
    gate.open();
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(responseTo(sent, 21)).toEqual({ id: 21, result: {} });
    expect(completedTurnStatuses(sent)).toEqual(["completed", "interrupted"]);
    await completeTurn(turns, sent, claude, 12);
    expect(await promptsUntil(claude, 2)).toEqual(["prompt 10", "prompt 12"]);
  });

  test("runs a turn answered after turn/completed only once the turn before it is cleared up", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const gate = createGate();
    let holdCleanup = false;
    const { turns, sent } = await harness([claude], {
      files: {
        removeMarker: async (target) => {
          if (holdCleanup) await gate.promise;
          return removeFile(target);
        },
      },
    });
    holdCleanup = true;
    await completeTurn(turns, sent, claude, 10);
    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    await settle();
    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(startedTurns(sent)).toEqual(["turn-1"]);

    gate.open();
    await until(() => startedTurns(sent).length === 2);
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
    expect(await promptsUntil(claude, 2)).toEqual(["prompt 10", "again"]);
  });

  test("fails a waiting turn without its thread status once the bridge is closing", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.startTurn(turnStart(11, "reply"), undefined);
    turns.closeAll();
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(completedTurnStatuses(sent)).toEqual(["failed", "failed"]);
    const waiting = sent.filter(
      (m) => m.params?.turnId === "turn-2" || m.params?.turn?.id === "turn-2",
    );
    expect(waiting.map((m) => m.method)).toEqual([
      "turn/started",
      "item/started",
      "item/completed",
      "error",
      "turn/completed",
    ]);
    expect(waiting[1]?.params.item).toMatchObject({
      type: "userMessage",
      content: [{ type: "text", text: "reply" }],
    });
    expect(waiting.at(-1)?.params.turn.error.message).toBe(
      "the bridge is shutting down",
    );
    expect(
      sent
        .filter((m) => m.method === "thread/status/changed")
        .map((m) => m.params.status.type),
    ).toEqual(["active", "idle"]);
  });
});

describe("clientUserMessageId", () => {
  test("refuses a copy of a message that is still waiting to run", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.startTurn(withMessageId(turnStart(11, "reply"), "m-1"), undefined);
    turns.startTurn(withMessageId(turnStart(12, "reply"), "m-1"), undefined);
    claude.emit(sdk(success()));
    await until(() => responseTo(sent, 11) !== undefined);
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);
    await until(() => responseTo(sent, 12) !== undefined);

    expect(responseTo(sent, 11)?.result).toBeDefined();
    expect(responseTo(sent, 12)).toEqual(DUPLICATE(12));
    expect(completedTurnStatuses(sent)).toEqual(["completed", "completed"]);
    const user = completedItems(sent).filter(
      (item) => item.type === "userMessage",
    );
    expect(user.map((item) => item.clientId)).toEqual([null, "m-1"]);
  });

  test("refuses a message delivered again after the bridge restarts", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const before = await harness([first]);
    before.turns.startTurn(
      withMessageId(turnStart(10, "reply"), "m-1"),
      undefined,
    );
    await until(() => responseTo(before.sent, 10) !== undefined);
    first.emit(sdk(success()));
    await until(() => before.store.get(THREAD)?.runState === "idle");
    expect(completedTurnStatuses(before.sent)).toEqual(["completed"]);
    const second = fakeClaude(SUBSCRIPTION);

    const after = await harness([second]);
    after.turns.startTurn(
      withMessageId(turnStart(11, "reply"), "m-1"),
      undefined,
    );
    await settle();

    expect(after.sent).toEqual([DUPLICATE(11)]);
    expect(second.started()).toBe(false);
  });

  test("refuses a message whose id cannot be saved without starting Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let writes = 0;
    const { turns, sent, store } = await harness([claude], {
      files: {
        writeState: async (target, content) =>
          ++writes === 2 ? diskFull(target) : writeFileAtomic(target, content),
      },
    });

    turns.startTurn(withMessageId(turnStart(10, "reply"), "m-1"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    // The refusal is sent inside the guarded write, so the run state clears only after it.
    await until(() => store.get(THREAD)?.runState === "idle");
    await settle();

    expect(sent).toEqual([
      {
        id: 10,
        error: {
          code: -32600,
          message:
            "the message id could not be saved, so the message was not run to avoid running it twice",
        },
      },
    ]);
    expect(claude.started()).toBe(false);
  });

  test("accepts a message again after it was refused before running", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let writes = 0;
    const { turns, sent } = await harness([claude], {
      files: {
        writeState: async (target, content) =>
          ++writes === 1 ? diskFull(target) : writeFileAtomic(target, content),
      },
    });

    turns.startTurn(withMessageId(turnStart(10, "reply"), "m-1"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    turns.startTurn(withMessageId(turnStart(11, "reply"), "m-1"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);

    expect(responseTo(sent, 10)?.error.message).toBe(
      "the Claude thread could not be saved",
    );
    expect(responseTo(sent, 11)?.result.turn).toMatchObject({
      status: "inProgress",
    });
  });
});

describe("several workers", () => {
  test("run their turns at once, each in its own directory, session and thread tools", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { sent, store, settings, links } = await twoWorkers([first, second]);

    await until(() => second.started());
    second.emit(sdk({ ...answer("msg-b", "ok"), session_id: "se-b" }));
    second.emit(sdk({ ...success(), session_id: "se-b" }));
    await until(() => completedOn(sent, OTHER_THREAD) !== undefined);
    expect(completedOn(sent, THREAD)).toBeUndefined();
    first.emit(sdk(answer("msg-a", "ok")));
    first.emit(sdk(success()));
    await until(() => completedOn(sent, THREAD) !== undefined);
    await until(
      () =>
        store.get(THREAD)?.runState === "idle" &&
        store.get(OTHER_THREAD)?.runState === "idle",
    );

    expect(settings.map((session) => session.cwd)).toEqual([dir, OTHER_DIR]);
    expect(links).toEqual([THREAD, OTHER_THREAD]);
    expect(store.get(THREAD)).toMatchObject({
      sessionId: "se-1",
      worktree: dir,
    });
    expect(store.get(OTHER_THREAD)).toMatchObject({
      sessionId: "se-b",
      worktree: OTHER_DIR,
    });
  });

  test("run at once on the connection each repository chooses", async () => {
    const first = fakeClaude(VERTEX_ACCOUNT);
    const second = fakeClaude(SUBSCRIPTION);
    const { settings } = await twoWorkers([first, second], {
      resolveConnection: async (worktree) =>
        Result.ok(worktree === dir ? VERTEX : SUBSCRIPTION_CONNECTION),
      model: VERTEX_MODEL,
    });

    await until(() => second.started());

    expect(settings.map((session) => session.connection.provider)).toEqual([
      "vertex",
      "subscription",
    ]);
    expect(first.options().env).toMatchObject({
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "sidework-project",
    });
    expect(second.options().env).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
  });

  test("leave the other worker's turn and prompt open when one is stopped", async () => {
    const first = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await twoWorkers([first, second]);
    await until(() => second.started());
    const decision = askTool(second, "Bash", { command: "ls" });
    const request = await appRequest(sent);

    turns.interruptTurn(interrupt(20, "turn-1"));
    first.emit(
      sdk(result({ subtype: "error_during_execution", is_error: true })),
    );
    await until(() => completedOn(sent, THREAD) !== undefined);

    expect(request.params.threadId).toBe(OTHER_THREAD);
    expect(resolvedRequests(sent)).toEqual([]);
    expect(second.interrupts()).toBe(0);
    turns.answerRequest({ id: request.id, result: { decision: "accept" } });
    expect(await decision).toEqual({ behavior: "allow" });
    second.emit(sdk(success()));
    await until(() => completedOn(sent, OTHER_THREAD) !== undefined);
    expect(completedOn(sent, THREAD)).toMatchObject({ status: "interrupted" });
    expect(completedOn(sent, OTHER_THREAD)).toMatchObject({
      status: "completed",
    });
  });

  test("keep the other worker running when one worker's Claude fails", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { sent } = await twoWorkers([first, second]);
    await until(() => second.started());

    first.fail(new Error("socket closed"));
    await until(() => completedOn(sent, THREAD) !== undefined);
    second.emit(sdk(success()));
    await until(() => completedOn(sent, OTHER_THREAD) !== undefined);

    expect(completedOn(sent, THREAD)).toMatchObject({ status: "failed" });
    expect(completedOn(sent, OTHER_THREAD)).toMatchObject({
      status: "completed",
    });
    expect(first.closes()).toBe(1);
    expect(second.closes()).toBe(0);
  });
});

describe("turn/start carrying another thread's message", () => {
  test("refuses a message from a reviewer that another worker created", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await registeredWorkers([claude]);

    turns.startTurn(reply(10, THREAD, OTHER_REVIEWER), undefined);
    await settle();

    expect(sent).toEqual([
      {
        id: 10,
        error: {
          code: -32600,
          message:
            "this message comes from a reviewer of another Claude thread",
        },
      },
    ]);
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "refused",
      reason: "reply_to_other_worker",
      error: null,
    });
    expect(claude.started()).toBe(false);
  });

  test("starts a thread that another worker's reviewer created", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store } = await registeredWorkers([claude]);

    turns.startTurn(
      reply(10, THREAD, OTHER_REVIEWER, "create_thread"),
      undefined,
    );
    await until(() => claude.started());
    turns.startTurn(reply(11, THREAD, OTHER_REVIEWER), undefined);
    await settle();

    expect(store.get(THREAD)?.requesterThreadIds).toEqual([OTHER_REVIEWER]);
    expect(
      sent.filter((message) => message.id === 11 && "error" in message),
    ).toEqual([]);
  });

  test("refuses a message from a reviewer another worker is still saving", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const gate = createGate();
    let holdWrites = false;
    const { turns, sent, store } = await registeredWorkers([claude], {
      writeState: async (target, content) => {
        if (holdWrites) await gate.promise;
        return writeFileAtomic(target, content);
      },
    });
    holdWrites = true;
    const adding = store.addReviewer(THREAD, NEW_REVIEWER);

    turns.startTurn(reply(10, OTHER_THREAD, NEW_REVIEWER), undefined);
    await settle();
    gate.open();

    expect(sent).toEqual([
      {
        id: 10,
        error: {
          code: -32600,
          message:
            "this message comes from a reviewer of another Claude thread",
        },
      },
    ]);
    expect(claude.started()).toBe(false);
    const added = await adding;
    expect(added.isOk() && added.value.reviewerThreadIds).toEqual([
      NEW_REVIEWER,
    ]);
  });

  test.each([
    {
      name: "its own reviewer",
      threadId: OTHER_THREAD,
      source: OTHER_REVIEWER,
    },
    {
      name: "a thread that is no reviewer",
      threadId: THREAD,
      source: "th-lead",
    },
  ])("passes a message from $name to Claude and shows it as the call output the app labels as sent from another thread", async ({
    threadId,
    source,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await registeredWorkers([claude]);

    turns.startTurn(reply(10, threadId, source), undefined);
    await until(() => claude.started());

    expect(await firstPrompt(claude.prompt())).toBe(delegation(source));
    const shown = sent
      .filter((m) => m.method === "item/started")
      .map((m) => m.params.item);
    expect(shown).toEqual([
      {
        type: "functionCallOutput",
        id: expect.any(String),
        name: "send_message_to_thread",
        namespace: "codex_app",
        output: delegation(source),
      },
    ]);
  });

  test.each([
    { name: "its own reviewer", source: OTHER_REVIEWER, expected: [] },
    { name: "the thread itself", source: OTHER_THREAD, expected: [] },
    { name: "another Claude thread", source: THREAD, expected: [] },
    {
      name: "a Codex thread that is no reviewer",
      source: "th-lead",
      expected: ["th-lead"],
    },
  ])("saves the sender when it is $name only if it is a Codex thread no one reviews for", async ({
    source,
    expected,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, store } = await registeredWorkers([claude]);

    turns.startTurn(reply(10, OTHER_THREAD, source), undefined);
    await until(() => claude.started());

    expect(store.get(OTHER_THREAD)?.requesterThreadIds).toEqual(expected);
  });

  test.each([
    { tool: "create_thread" },
    { tool: "send_message_to_thread" },
  ])("lets Claude message the Codex worker that delegated work by $tool but not an unrelated thread", async ({
    tool,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, settings, toolCalls } = await harness([claude], {
      linkRequest: async () => Result.ok(TOOL_ANSWER),
    });

    turns.startTurn(reply(10, THREAD, CODEX_WORKER, tool), undefined);
    await until(() => claude.started());
    const [answered, unrelated] = await messageThreads(settings[0], [
      CODEX_WORKER,
      "th-fixture-unrelated",
    ]);

    expect(answered?.isError).toBeFalsy();
    expect(unrelated?.isError).toBe(true);
    expect(toolCalls).toEqual([
      expect.objectContaining({
        tool: "send_message_to_thread",
        arguments: { threadId: CODEX_WORKER, prompt: "review this" },
      }),
    ]);
  });

  test("refuses a delegated message whose sender cannot be saved without starting Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let failWrites = false;
    const { turns, sent, store } = await registeredWorkers([claude], {
      writeState: async (target, content) =>
        failWrites ? diskFull(target) : writeFileAtomic(target, content),
    });
    failWrites = true;

    turns.startTurn(reply(10, THREAD, CODEX_WORKER), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    await settle();

    expect(responseTo(sent, 10)?.error.message).toBe(
      "the thread that sent this message could not be saved, so Claude could not answer it and the message was not run",
    );
    expect(claude.started()).toBe(false);
    expect(store.get(THREAD)?.requesterThreadIds).toEqual([]);
  });

  test("runs a delegated message once when it is sent again after its sender could not be saved", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let failWrites = false;
    const { turns, sent, store } = await registeredWorkers([claude], {
      writeState: async (target, content) =>
        failWrites ? diskFull(target) : writeFileAtomic(target, content),
    });
    const delegated = (id: number) =>
      withMessageId(reply(id, THREAD, CODEX_WORKER), "m-1");
    failWrites = true;
    turns.startTurn(delegated(10), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    failWrites = false;

    turns.startTurn(delegated(11), undefined);
    await until(() => claude.started());
    turns.startTurn(delegated(12), undefined);
    await until(() => responseTo(sent, 12) !== undefined);

    expect(responseTo(sent, 10)?.error.message).toBe(
      "the thread that sent this message could not be saved, so Claude could not answer it and the message was not run",
    );
    expect(responseTo(sent, 11)?.result.turn).toMatchObject({
      status: "inProgress",
    });
    expect(responseTo(sent, 12)).toEqual(DUPLICATE(12));
    expect(startedTurns(sent)).toHaveLength(1);
    expect(store.get(THREAD)?.requesterThreadIds).toEqual([CODEX_WORKER]);
  });

  test("runs a message from a sender already saved when the store cannot be written", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let failWrites = false;
    const { turns, sent, store } = await registeredWorkers([claude], {
      writeState: async (target, content) =>
        failWrites ? diskFull(target) : writeFileAtomic(target, content),
    });
    turns.startTurn(reply(10, THREAD, CODEX_WORKER), undefined);
    await until(() => claude.prompted());
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 1);
    turns.startTurn(reply(11, THREAD, "th-lead"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);
    expect(store.get(THREAD)?.requesterThreadIds).toEqual([
      CODEX_WORKER,
      "th-lead",
    ]);
    failWrites = true;

    turns.startTurn(reply(12, THREAD, CODEX_WORKER), undefined);
    await until(() => responseTo(sent, 12) !== undefined);

    expect(responseTo(sent, 12)?.result.turn).toMatchObject({
      status: "inProgress",
    });
  });
});

describe("another thread's message arriving on a busy thread", () => {
  test("joins the running turn as Codex steers it and lets Claude answer the sender", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events, store, settings } = await harness([claude], {
      linkRequest: async () => Result.ok(TOOL_ANSWER),
    });
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());

    turns.startTurn(reply(11, THREAD, CODEX_WORKER), undefined);
    const [prompt, steered] = await readPrompts(claude, 2);

    expect(responseTo(sent, 11)).toEqual({
      id: 11,
      result: {
        turn: {
          id: "turn-1",
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: expect.any(Number),
          completedAt: null,
          durationMs: null,
        },
      },
    });
    expect(steered?.message.content).toBe(delegation(CODEX_WORKER));
    expect(store.get(THREAD)?.requesterThreadIds).toEqual([CODEX_WORKER]);
    expect(events).toContainEqual({ event: "claude_turn", step: "steered" });
    const shown = sent.filter(
      (m) =>
        m.method === "item/started" &&
        m.params.item.type === "functionCallOutput",
    );
    expect(shown.map((m) => [m.params.turnId, m.params.item])).toEqual([
      [
        "turn-1",
        {
          type: "functionCallOutput",
          id: expect.any(String),
          name: "send_message_to_thread",
          namespace: "codex_app",
          output: delegation(CODEX_WORKER),
        },
      ],
    ]);
    const [answered] = await messageThreads(settings[0], [CODEX_WORKER]);
    expect(answered?.isError).toBeFalsy();

    claude.emit(sdk(success([prompt?.uuid, steered?.uuid])));
    await until(() => completedTurnStatuses(sent).length === 1);
    await settle();
    expect(startedTurns(sent)).toEqual(["turn-1"]);
    expect(completedTurnStatuses(sent)).toEqual(["completed"]);
  });

  test("waits behind a turn already waiting so the messages run in the order they came", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    turns.startTurn(turnStart(11, "next"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);

    turns.startTurn(reply(12, THREAD, CODEX_WORKER), undefined);
    await until(() => responseTo(sent, 12) !== undefined);

    expect(responseTo(sent, 12)?.result.turn).toMatchObject({ id: "turn-3" });
    for (const turn of [1, 2, 3]) {
      await until(() => startedTurns(sent).length === turn);
      claude.emit(sdk(success()));
      await until(() => completedTurnStatuses(sent).length === turn);
    }
    expect(startedTurns(sent)).toEqual(["turn-1", "turn-2", "turn-3"]);
    expect(await promptsUntil(claude, 3)).toEqual([
      "hello",
      "next",
      delegation(CODEX_WORKER),
    ]);
  });

  test("runs as the next turn when the running turn is being stopped", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await harness([claude]);
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => claude.interrupts() === 1);

    turns.startTurn(reply(11, THREAD, CODEX_WORKER), undefined);
    await until(() => responseTo(sent, 11) !== undefined);
    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });

    claude.emit(
      sdk(result({ subtype: "error_during_execution", is_error: true })),
    );
    await until(() => startedTurns(sent).length === 2);
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(completedTurnStatuses(sent)).toEqual(["interrupted", "completed"]);
    expect(await promptsUntil(claude, 2)).toEqual([
      "hello",
      delegation(CODEX_WORKER),
    ]);
  });

  test("passes messages to Claude in the order they came while the first sender is still being saved", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const gate = createGate();
    let holdWrites = false;
    const { turns, sent } = await registeredWorkers([claude], {
      writeState: async (target, content) => {
        if (holdWrites) await gate.promise;
        return writeFileAtomic(target, content);
      },
    });
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    holdWrites = true;

    turns.startTurn(reply(11, THREAD, CODEX_WORKER), undefined);
    turns.startTurn(reply(12, THREAD, OTHER_THREAD), undefined);
    await settle();
    expect(responseTo(sent, 12)).toBeUndefined();
    gate.open();
    const [prompt, first, second] = await readPrompts(claude, 3);

    expect([first, second].map((m) => m?.message.content)).toEqual([
      delegation(CODEX_WORKER),
      delegation(OTHER_THREAD),
    ]);
    expect(
      [responseTo(sent, 11), responseTo(sent, 12)].map(
        (m) => m?.result.turn.id,
      ),
    ).toEqual(["turn-1", "turn-1"]);
    claude.emit(sdk(success([prompt?.uuid, first?.uuid, second?.uuid])));
    await until(() => completedTurnStatuses(sent).length === 1);
    await settle();
    expect(startedTurns(sent)).toEqual(["turn-1"]);
  });

  test("runs as the next turn when the running turn is stopped while the sender is being saved, ahead of a message that came later", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const gate = createGate();
    let holdWrites = false;
    const { turns, sent } = await registeredWorkers([claude], {
      writeState: async (target, content) => {
        if (holdWrites) await gate.promise;
        return writeFileAtomic(target, content);
      },
    });
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    holdWrites = true;
    turns.startTurn(reply(11, THREAD, CODEX_WORKER), undefined);
    await settle();

    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => claude.interrupts() === 1);
    turns.startTurn(reply(12, THREAD, OTHER_THREAD), undefined);
    await settle();
    expect(responseTo(sent, 12)).toBeUndefined();
    gate.open();
    await until(() => responseTo(sent, 12) !== undefined);
    expect(
      [responseTo(sent, 11), responseTo(sent, 12)].map(
        (m) => m?.result.turn.id,
      ),
    ).toEqual(["turn-2", "turn-3"]);
    claude.emit(
      sdk(result({ subtype: "error_during_execution", is_error: true })),
    );
    for (const started of [2, 3]) {
      await until(() => startedTurns(sent).length === started);
      claude.emit(sdk(success()));
      await until(() => completedTurnStatuses(sent).length === started);
    }

    expect(completedTurnStatuses(sent)).toEqual([
      "interrupted",
      "completed",
      "completed",
    ]);
    expect(await promptsUntil(claude, 3)).toEqual([
      "hello",
      delegation(CODEX_WORKER),
      delegation(OTHER_THREAD),
    ]);
  });

  test("runs ahead of a message typed after it when the running turn is stopped while the sender is being saved", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const gate = createGate();
    let holdWrites = false;
    const { turns, sent } = await registeredWorkers([claude], {
      writeState: async (target, content) => {
        if (holdWrites) await gate.promise;
        return writeFileAtomic(target, content);
      },
    });
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    holdWrites = true;
    turns.startTurn(reply(11, THREAD, CODEX_WORKER), undefined);
    await settle();

    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => claude.interrupts() === 1);
    turns.startTurn(turnStart(12, "next"), undefined);
    await settle();
    expect(responseTo(sent, 12)).toBeUndefined();
    gate.open();
    await until(() => responseTo(sent, 12) !== undefined);
    expect(
      [responseTo(sent, 11), responseTo(sent, 12)].map(
        (m) => m?.result.turn.id,
      ),
    ).toEqual(["turn-2", "turn-3"]);
    claude.emit(
      sdk(result({ subtype: "error_during_execution", is_error: true })),
    );
    for (const started of [2, 3]) {
      await until(() => startedTurns(sent).length === started);
      claude.emit(sdk(success()));
      await until(() => completedTurnStatuses(sent).length === started);
    }

    expect(await promptsUntil(claude, 3)).toEqual([
      "hello",
      delegation(CODEX_WORKER),
      "next",
    ]);
  });

  test("waits as the next turn when it carries a message id, which is saved before the message runs", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store } = await harness([claude]);
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());

    turns.startTurn(
      withMessageId(reply(11, THREAD, CODEX_WORKER), "msg-11"),
      undefined,
    );
    await until(() => responseTo(sent, 11) !== undefined);
    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    claude.emit(sdk(success()));
    await until(() => startedTurns(sent).length === 2);
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(store.get(THREAD)?.messageIds).toContain("msg-11");
    expect(await promptsUntil(claude, 2)).toEqual([
      "hello",
      delegation(CODEX_WORKER),
    ]);
  });

  test("refuses a message whose sender cannot be saved without passing it to Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    let failWrites = false;
    const { turns, sent, store } = await registeredWorkers([claude], {
      writeState: async (target, content) =>
        failWrites ? diskFull(target) : writeFileAtomic(target, content),
    });
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.prompted());
    failWrites = true;

    turns.startTurn(reply(11, THREAD, CODEX_WORKER), undefined);
    await until(() => responseTo(sent, 11) !== undefined);

    expect(responseTo(sent, 11)?.error.message).toBe(
      "the thread that sent this message could not be saved, so Claude could not answer it and the message was not run",
    );
    expect(store.get(THREAD)?.requesterThreadIds).toEqual([]);
    claude.emit(sdk(success()));
    await until(() => completedTurnStatuses(sent).length === 1);
    await settle();
    expect(startedTurns(sent)).toEqual(["turn-1"]);
    expect(await promptsUntil(claude, 1)).toEqual(["hello"]);
  });
});

describe("closeAll", () => {
  test("stops Claude and ends the running turn as failed", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.closeAll();
    await until(() => turnCompleted(sent) !== undefined);

    expect(claude.closes()).toBe(1);
    expect(turnCompleted(sent)).toMatchObject({ status: "failed" });
  });

  test("refuses a turn that arrives after closing", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.closeAll();
    turns.startTurn(turnStart(11, "again"), undefined);
    await settle();

    expect(sent).toEqual([
      {
        id: 11,
        error: { code: -32600, message: "the bridge is shutting down" },
      },
    ]);
    expect(claude.started()).toBe(false);
  });
});

// Leaves turn-1 ended by its result while the interrupt receipt is still held back.
const interruptBeforeReceipt = async (
  turns: ReturnType<typeof createTurnController>,
  sent: Sent[],
  claude: ReturnType<typeof fakeClaude>,
) => {
  turns.startTurn(turnStart(10, "hello"), undefined);
  await until(() => claude.prompted());
  turns.interruptTurn(interrupt(20, "turn-1"));
  claude.emit(
    sdk(result({ subtype: "error_during_execution", is_error: true })),
  );
  await until(() => turnCompleted(sent) !== undefined);
  expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
};

const registeredWorkers = async (
  fakes: ReturnType<typeof fakeClaude>[],
  files: Parameters<typeof openThreadStore>[1] = {},
) => {
  const started = await harness(fakes, { adopt: false, files });
  for (const [threadId, worktree] of [
    [THREAD, dir],
    [OTHER_THREAD, OTHER_DIR],
  ] as const) {
    const registered = await started.store.register({
      threadId,
      model: MODEL,
      worktree,
    });
    expect(registered.isOk() && registered.value.threadId).toBe(threadId);
  }
  const added = await started.store.addReviewer(OTHER_THREAD, OTHER_REVIEWER);
  expect(added.isOk() && added.value.reviewerThreadIds).toEqual([
    OTHER_REVIEWER,
  ]);
  return started;
};

const completedOn = (sent: Sent[], threadId: string) =>
  sent.find(
    (message) =>
      message.method === "turn/completed" &&
      message.params.threadId === threadId,
  )?.params.turn;

const OTHER_REVIEWER = "th-fixture-reviewer-2";

const NEW_REVIEWER = "th-fixture-reviewer-1";

const CODEX_WORKER = "th-fixture-codex-worker";

const messageReviewer = async (session: ClaudeSessionSettings | undefined) => {
  const [sent] = await messageThreads(session, [NEW_REVIEWER]);
  return sent ?? expect.unreachable("no message was sent");
};

// One server instance takes one connection, so every message goes through the same client.
const messageThreads = async (
  session: ClaudeSessionSettings | undefined,
  threadIds: string[],
) => {
  const server = session?.mcpServers?.codex_link;
  if (server === undefined || !("instance" in server)) {
    return expect.unreachable("Claude has no thread tool server");
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  const results = [];
  for (const threadId of threadIds) {
    results.push(
      await client.callTool({
        name: "send_message_to_thread",
        arguments: { threadId, prompt: "review this" },
      }),
    );
  }
  return results;
};

const DUPLICATE = (id: number) => ({
  id,
  error: {
    code: -32600,
    message: "this message was already delivered to the Claude thread",
  },
});

const TOOL_ANSWER = { content: [{ type: "text", text: "sent" }] };

const UNANSWERED = {
  _tag: "ServerRequestUnanswered",
  method: "mcpServer/tool/call",
  message: "the server closed before answering mcpServer/tool/call",
} as InferErr<Awaited<ReturnType<ServerRequest>>>;
