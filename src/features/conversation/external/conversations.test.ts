import { describe, expect, test } from "bun:test";

import { firstTurnPrompt } from "./protocol.ts";
import { createExternalRuntime } from "./runtime.ts";
import {
  binding,
  externalEnv,
  fakeTurn,
  hello,
  innerRuntime,
  intent,
  records,
  settle,
} from "./testing/fake-adapter.ts";

const INTENT_1 = "00000000-0000-4000-8000-000000000001";

describe("createExternalConversations connection", () => {
  test("says hello with its bridge id, mode and version, and answers the adapter's hello with ready", async () => {
    const { conversations, adapter } = externalEnv({ mode: "observe" });

    conversations.start();
    adapter.latest().say(hello());
    await settle();

    expect(adapter.latest().sent).toEqual([
      {
        v: 1,
        type: "hello",
        bridgeId: "bridge-1",
        adapterId: "taskctl",
        mode: "observe",
        versions: [1],
      },
      {
        v: 1,
        type: "ready",
        bridgeId: "bridge-1",
        bindings: [],
        pending: [],
        conflicts: [],
      },
    ]);
  });

  test("stops an adapter that speaks another version and never starts it again", async () => {
    const { conversations, adapter, timers } = externalEnv();

    conversations.start();
    adapter.latest().say({ v: 2, type: "hello", adapterId: "taskctl" });
    timers.runAll();

    expect(adapter.processes).toHaveLength(1);
    expect(adapter.latest().stopped).toBe(true);
  });

  test("starts the adapter again after it exits, waiting longer after each quick failure", () => {
    const { conversations, adapter, timers } = externalEnv();

    conversations.start();
    adapter.latest().exit();
    const first = timers.timers.filter((timer) => !timer.cancelled).at(-1)?.ms;
    timers.runAll();
    adapter.latest().exit();
    const second = timers.timers.filter((timer) => !timer.cancelled).at(-1)?.ms;

    expect([first, second]).toEqual([1_000, 2_000]);
    expect(adapter.processes).toHaveLength(2);
  });

  test("answers a request sent before the adapter's hello as not sent", () => {
    const { conversations, adapter, sends } = externalEnv({
      owners: { s1: "parent-1" },
    });

    conversations.start();
    adapter.latest().say({
      type: "request",
      id: 1,
      op: "cloud_send",
      sessionId: "s1",
      text: "hi",
    });

    expect(adapter.latest().responses()).toEqual([
      expect.objectContaining({
        id: 1,
        outcome: "not_sent",
        reason: "not_ready",
      }),
    ]);
    expect(sends).toEqual([]);
  });
});

describe("createExternalConversations observations", () => {
  test("tells the adapter of a link with the record it was linked at until it confirms it, and then as continued", async () => {
    const { conversations, adapter } = externalEnv({
      mode: "observe",
      owners: { s1: "parent-1" },
    });
    conversations.start();
    adapter.latest().say(hello());
    await settle();

    conversations.observe({
      sessionId: "s1",
      parentThreadId: "parent-1",
      phase: "linked",
      shownBefore: null,
      records: records("r1", "r2"),
    });
    conversations.observe({
      sessionId: "s1",
      parentThreadId: "parent-1",
      phase: "continued",
      shownBefore: "r2",
      records: records("r1", "r2", "r3"),
    });
    const [linked, stillLinked] = adapter.latest().events("session_records");
    adapter.latest().say({ type: "observed", eventId: stillLinked?.eventId });
    conversations.observe({
      sessionId: "s1",
      parentThreadId: "parent-1",
      phase: "continued",
      shownBefore: "r3",
      records: records("r1", "r2", "r3", "r4"),
    });

    expect(
      adapter
        .latest()
        .events("session_records")
        .map(({ phase, linkedAt, shownBefore, link }) => ({
          phase,
          linkedAt,
          shownBefore,
          link,
        })),
    ).toEqual([
      { phase: "linked", linkedAt: "r2", shownBefore: null, link: "parent-1" },
      { phase: "linked", linkedAt: "r2", shownBefore: "r2", link: "parent-1" },
      {
        phase: "continued",
        linkedAt: undefined,
        shownBefore: "r3",
        link: "parent-1",
      },
    ]);
    expect(linked?.records).toHaveLength(2);
  });

  test("hands a review read while the adapter was stopped over once after it reconnects, and never one from before the link", async () => {
    const { conversations, adapter, timers } = externalEnv({
      mode: "observe",
      owners: { s1: "parent-1" },
    });
    // What taskctl keeps: the records each link excludes and the reviews it handled.
    const excluded = new Set<string>();
    const handled: string[] = [];
    const consume = (event: Record<string, unknown>) => {
      const uuids = (event.records as { uuid: string }[]).map((r) => r.uuid);
      if (event.phase === "linked" && excluded.size === 0) {
        const until = uuids.indexOf(event.linkedAt as string);
        for (const uuid of uuids.slice(0, until + 1)) excluded.add(uuid);
      }

      for (const uuid of uuids) {
        if (!excluded.has(uuid) && !handled.includes(uuid)) handled.push(uuid);
      }
    };

    conversations.start();
    adapter.latest().say(hello());
    await settle();
    conversations.observe({
      sessionId: "s1",
      parentThreadId: "parent-1",
      phase: "linked",
      shownBefore: null,
      records: records("review-before-link"),
    });
    const [linked] = adapter.latest().events("session_records");
    if (linked === undefined) return expect.unreachable();
    consume(linked);
    adapter.latest().say({ type: "observed", eventId: linked.eventId });

    adapter.latest().exit();
    conversations.observe({
      sessionId: "s1",
      parentThreadId: "parent-1",
      phase: "continued",
      shownBefore: "review-before-link",
      records: records("review-before-link", "review-while-away"),
    });
    conversations.observe({
      sessionId: "s1",
      parentThreadId: "parent-1",
      phase: "continued",
      shownBefore: "review-while-away",
      records: records("review-before-link", "review-while-away", "reply"),
    });
    timers.runAll();
    adapter.latest().say(hello());
    await settle();
    for (const event of adapter.latest().events("session_records"))
      consume(event);

    expect(adapter.processes).toHaveLength(2);
    expect(adapter.latest().events("session_records")).toHaveLength(1);
    expect(handled).toEqual(["review-while-away", "reply"]);
  });

  test("leaves out a session that is no longer linked to the chat that saw it", async () => {
    const owners: Record<string, string> = { s1: "parent-1" };
    const { conversations, adapter } = externalEnv({
      mode: "observe",
      owners,
    });
    conversations.observe({
      sessionId: "s1",
      parentThreadId: "parent-1",
      phase: "continued",
      shownBefore: null,
      records: records("r1"),
    });
    delete owners.s1;

    conversations.start();
    adapter.latest().say(hello());
    await settle();

    expect(adapter.latest().events("session_records")).toEqual([]);
  });
});

describe("createExternalConversations in observe mode", () => {
  test("refuses every write and carries none out, and leaves every chat to the bridge", async () => {
    const { conversations, adapter, calls, sends, ownStarts } = externalEnv({
      mode: "observe",
      owners: { s1: "parent-1" },
    });
    conversations.start();
    adapter.latest().say(hello([{ conversationId: "c1", threadId: "chat-1" }]));
    await settle();

    adapter.latest().say({
      type: "request",
      id: 1,
      op: "create_conversation",
      conversationId: "c2",
      callerThreadId: "parent-1",
      arguments: { model: "claude-sonnet-5-5" },
    });
    adapter.latest().say({
      type: "request",
      id: 2,
      op: "bind_conversation",
      conversationId: "c3",
      threadId: "chat-3",
    });
    adapter.latest().say({
      type: "request",
      id: 3,
      op: "post",
      conversationId: "c1",
      text: "hi",
    });
    adapter.latest().say({
      type: "request",
      id: 4,
      op: "cloud_send",
      sessionId: "s1",
      text: "hi",
    });
    await settle();
    const route = await conversations.route("chat-1", null);

    expect(
      adapter
        .latest()
        .responses()
        .map(({ id, outcome, reason }) => ({ id, outcome, reason })),
    ).toEqual(
      [1, 2, 3, 4].map((id) => ({
        id,
        outcome: "rejected",
        reason: "observe_only",
      })),
    );
    expect({ calls, sends, ownStarts }).toEqual({
      calls: [],
      sends: [],
      ownStarts: [],
    });
    expect(route).toEqual({ kind: "normal" });
  });
});

describe("createExternalConversations creates", () => {
  test("saves the intent before asking the app, and binds the chat whose first turn arrives before the create answers, without Claude", async () => {
    const env = externalEnv();
    const runs: string[] = [];
    const runtime = createExternalRuntime(
      innerRuntime(runs),
      env.conversations,
    );
    const savedWhenAsked: unknown[] = [];
    const first = fakeTurn("turn-1", {
      threadId: "chat-1",
      createdBy: { source: "parent-1", prompt: firstTurnPrompt(INTENT_1) },
    });
    let ran: Promise<void> = Promise.resolve();
    env.env.answer = async (call) => {
      savedWhenAsked.push(env.lastSaved());
      ran = runtime.run(first.running);
      await settle();
      env.adapter.latest().say({
        type: "turn_output",
        turnId: "turn-1",
        text: "a review",
      });
      env.adapter.latest().say({
        type: "turn_end",
        turnId: "turn-1",
        status: "completed",
      });
      await ran;
      return { outcome: "done", threadId: "chat-1", call };
    };

    env.conversations.start();
    env.adapter.latest().say(hello());
    await settle();

    env.adapter.latest().say({
      type: "request",
      id: "create-1",
      op: "create_conversation",
      conversationId: "c1",
      callerThreadId: "parent-1",
      arguments: { model: "claude-sonnet-5-5", title: "Review" },
    });
    await until(() => env.adapter.latest().responses().length === 1);

    expect(savedWhenAsked).toEqual([
      { bindings: [], intents: [intent(INTENT_1, "c1")] },
    ]);
    expect(env.calls[0]?.arguments).toEqual({
      model: "claude-sonnet-5-5",
      title: "Review",
      prompt: `/external-conversation ${INTENT_1}`,
    });
    expect(runs).toEqual([]);
    expect(first.texts()).toEqual(["a review"]);
    expect(env.adapter.latest().events("turn")).toEqual([
      expect.objectContaining({ kind: "opened", conversationId: "c1" }),
    ]);
    expect(env.adapter.latest().responses()).toEqual([
      expect.objectContaining({
        id: "create-1",
        bridgeId: "bridge-1",
        outcome: "done",
        threadId: "chat-1",
      }),
    ]);
    expect(env.lastSaved()).toEqual({
      bindings: [binding("c1", "chat-1")],
      intents: [],
    });
  });

  test("keeps the intent of a create whose outcome is unknown, never asks again, and binds the chat once its first turn arrives", async () => {
    const env = externalEnv();
    const runs: string[] = [];
    const runtime = createExternalRuntime(
      innerRuntime(runs),
      env.conversations,
    );
    env.env.answer = async () => ({ outcome: "unknown", message: "lost" });
    env.conversations.start();
    env.adapter.latest().say(hello());
    await settle();
    const create = (id: number) =>
      env.adapter.latest().say({
        type: "request",
        id,
        op: "create_conversation",
        conversationId: "c1",
        callerThreadId: "parent-1",
        arguments: { model: "claude-sonnet-5-5" },
      });

    create(1);
    await until(() => env.adapter.latest().responses().length === 1);
    create(2);
    await until(() => env.adapter.latest().responses().length === 2);
    const late = fakeTurn("turn-late", {
      threadId: "chat-9",
      createdBy: { source: "parent-1", prompt: firstTurnPrompt(INTENT_1) },
    });
    void runtime.run(late.running);
    await settle();
    create(3);
    await until(() => env.adapter.latest().responses().length === 3);

    expect(
      env.adapter
        .latest()
        .responses()
        .map(({ outcome, reason, threadId }) => ({
          outcome,
          reason,
          threadId,
        })),
    ).toEqual([
      { outcome: "unknown", reason: "pending_create", threadId: undefined },
      { outcome: "unknown", reason: "pending_create", threadId: undefined },
      { outcome: "done", reason: undefined, threadId: "chat-9" },
    ]);
    expect(env.calls).toHaveLength(1);
    expect(runs).toEqual([]);
    expect(env.adapter.latest().events("conversation_bound")).toEqual([
      expect.objectContaining({ conversationId: "c1", threadId: "chat-9" }),
    ]);
  });

  test("drops the intent of a create the app certainly did not make, so it may be asked again", async () => {
    const env = externalEnv();
    env.env.answer = async () => ({ outcome: "rejected", message: "no" });
    env.conversations.start();
    env.adapter.latest().say(hello());
    await settle();

    env.adapter.latest().say({
      type: "request",
      id: 1,
      op: "create_conversation",
      conversationId: "c1",
      callerThreadId: "parent-1",
      arguments: { model: "claude-sonnet-5-5" },
    });
    await until(() => env.adapter.latest().responses().length === 1);

    expect(env.adapter.latest().responses()[0]).toMatchObject({
      outcome: "rejected",
    });
    expect(env.lastSaved()).toEqual({ bindings: [], intents: [] });
  });

  test("answers a create of a conversation already shown with its chat, without asking the app", async () => {
    const env = externalEnv({
      state: { bindings: [binding("c1", "chat-1")], intents: [] },
    });
    env.conversations.start();
    env.adapter.latest().say(hello());
    await settle();

    env.adapter.latest().say({
      type: "request",
      id: 1,
      op: "create_conversation",
      conversationId: "c1",
      callerThreadId: "parent-1",
      arguments: { model: "claude-sonnet-5-5" },
    });
    await until(() => env.adapter.latest().responses().length === 1);

    expect(env.adapter.latest().responses()[0]).toMatchObject({
      outcome: "done",
      threadId: "chat-1",
      existing: true,
    });
    expect(env.calls).toEqual([]);
  });

  test.each([
    {
      name: "a chat on a model that is not Claude's",
      args: { model: "gpt-5" },
      state: { bindings: [], intents: [] },
      expected: { outcome: "invalid", reason: "not_claude_model" },
    },
    {
      name: "a state file that could not be read",
      args: { model: "claude-sonnet-5-5" },
      state: null,
      expected: { outcome: "not_sent", reason: "state_unavailable" },
    },
  ])("refuses a create for $name", async ({ args, state, expected }) => {
    const env = externalEnv({ state });
    env.conversations.start();
    env.adapter.latest().say(hello());
    await settle();

    env.adapter.latest().say({
      type: "request",
      id: 1,
      op: "create_conversation",
      conversationId: "c1",
      callerThreadId: "parent-1",
      arguments: args,
    });
    await until(() => env.adapter.latest().responses().length === 1);

    expect(env.adapter.latest().responses()[0]).toMatchObject(expected);
    expect(env.calls).toEqual([]);
  });

  test("stops a first turn that names an intent this bridge does not hold, without Claude", async () => {
    const env = externalEnv({
      state: { bindings: [], intents: [intent(INTENT_1, "c1", "parent-2")] },
    });
    const runs: string[] = [];
    const runtime = createExternalRuntime(
      innerRuntime(runs),
      env.conversations,
    );
    env.conversations.start();
    env.adapter.latest().say(hello());
    await settle();
    const turn = fakeTurn("turn-1", {
      createdBy: { source: "parent-1", prompt: firstTurnPrompt(INTENT_1) },
    });

    await runtime.run(turn.running);

    expect(turn.failure?._tag).toBe("ExternalConversationStopped");
    expect(runs).toEqual([]);
  });
});

describe("createExternalRuntime turns", () => {
  const boundEnv = async () => {
    const env = externalEnv({
      state: { bindings: [binding("c1", "chat-1")], intents: [] },
    });
    const runs: string[] = [];
    const runtime = createExternalRuntime(
      innerRuntime(runs),
      env.conversations,
    );
    env.conversations.start();
    env.adapter
      .latest()
      .say(hello([{ conversationId: "c1", threadId: "chat-1" }]));
    await settle();
    return { ...env, runs, runtime };
  };

  test("hands a message typed in a bound chat to the adapter and shows its answer", async () => {
    const { runtime, adapter, runs } = await boundEnv();
    const turn = fakeTurn("turn-1", { text: "is B1 not the old behavior?" });

    const ran = runtime.run(turn.running);
    await settle();
    adapter.latest().say({
      type: "turn_output",
      turnId: "turn-1",
      text: "passing it on",
      phase: "commentary",
    });
    adapter.latest().say({
      type: "turn_end",
      turnId: "turn-1",
      status: "completed",
    });
    await ran;

    expect(adapter.latest().events("turn")).toEqual([
      {
        v: 1,
        type: "event",
        event: "turn",
        turnId: "turn-1",
        threadId: "chat-1",
        conversationId: "c1",
        kind: "input",
        text: "is B1 not the old behavior?",
      },
    ]);
    expect(turn.texts()).toEqual(["passing it on"]);
    expect(turn.outcome).toEqual({ status: "completed" });
    expect(runs).toEqual([]);
  });

  test("tells the adapter to stop a turn the user stopped, and ends it as interrupted", async () => {
    const { runtime, adapter } = await boundEnv();
    const turn = fakeTurn("turn-1", { text: "hello" });

    const ran = runtime.run(turn.running);
    await settle();
    runtime.interrupt(turn.running, false);
    await ran;
    adapter.latest().say({
      type: "turn_output",
      turnId: "turn-1",
      text: "too late",
    });

    expect(adapter.latest().events("turn_stop")).toEqual([
      expect.objectContaining({ turnId: "turn-1" }),
    ]);
    expect(turn.outcome).toEqual({ status: "interrupted" });
    expect(turn.texts().join("\n")).not.toContain("too late");
  });

  test("stops the turn an exiting adapter held and a message sent while it is away, without Claude", async () => {
    const { runtime, adapter, runs } = await boundEnv();
    const held = fakeTurn("turn-1", { text: "hello" });

    const ran = runtime.run(held.running);
    await settle();
    adapter.latest().exit();
    await ran;
    const away = fakeTurn("turn-2", { text: "again" });
    await runtime.run(away.running);

    expect(held.failure?._tag).toBe("ExternalAdapterUnavailable");
    expect(away.failure?._tag).toBe("ExternalAdapterUnavailable");
    expect(runs).toEqual([]);
  });

  test("shows a post as a turn of the bridge's own and answers once it is shown", async () => {
    const { runtime, adapter, ownStarts } = await boundEnv();

    adapter.latest().say({
      type: "request",
      id: 7,
      op: "post",
      conversationId: "c1",
      text: "判定: LGTM",
    });
    await settle();
    const own = fakeTurn("own-1", { startedBy: "claude" });
    await runtime.run(own.running);
    await settle();

    expect(ownStarts).toEqual(["chat-1"]);
    expect(own.texts()).toEqual(["判定: LGTM"]);
    expect(adapter.latest().responses()).toEqual([
      expect.objectContaining({ id: 7, outcome: "done", threadId: "chat-1" }),
    ]);
  });

  test("answers a post as not sent when the chat cannot take a turn now", async () => {
    const env = await boundEnv();
    env.env.startOwnTurn = () => false;

    env.adapter.latest().say({
      type: "request",
      id: 7,
      op: "post",
      conversationId: "c1",
      text: "x",
    });
    await settle();

    expect(env.adapter.latest().responses()).toEqual([
      expect.objectContaining({ outcome: "not_sent", reason: "busy" }),
    ]);
  });

  test("reads a bound chat's history from the adapter", async () => {
    const { conversations, adapter } = await boundEnv();

    const read = conversations.history("chat-1");
    await settle();
    const [asked] = adapter
      .latest()
      .sent.filter((line) => line.op === "history");
    adapter.latest().say({
      type: "response",
      id: asked?.id,
      outcome: "done",
      entries: [
        { role: "assistant", text: "a review", at: "2026-11-06T00:00:00Z" },
      ],
    });

    expect(asked).toMatchObject({ conversationId: "c1", threadId: "chat-1" });
    expect(await read).toEqual([
      { role: "assistant", text: "a review", at: "2026-11-06T00:00:00Z" },
    ]);
  });

  test("refuses a message sent while a bound chat's turn runs", async () => {
    const { runtime } = await boundEnv();
    const turn = fakeTurn("turn-1", { text: "hello" });

    void runtime.run(turn.running);
    await settle();

    expect(
      await runtime.steer(turn.running, { text: "more", images: [] }),
    ).toBe("steer_not_sent");
  });
});

describe("createExternalConversations bindings", () => {
  test("adopts the declared bindings, keeps and tells one only this bridge confirmed, and stops a chat whose bindings conflict", async () => {
    const runs: string[] = [];
    const env = externalEnv({
      state: {
        bindings: [binding("c-only-here", "chat-2"), binding("c-x", "chat-3")],
        intents: [intent(INTENT_1, "c1")],
      },
    });
    const runtime = createExternalRuntime(
      innerRuntime(runs),
      env.conversations,
    );
    env.conversations.start();

    env.adapter.latest().say(
      hello([
        { conversationId: "c1", threadId: "chat-1" },
        { conversationId: "c-y", threadId: "chat-3" },
      ]),
    );
    await settle();
    const conflicted = fakeTurn("turn-1", { threadId: "chat-3", text: "hi" });
    await runtime.run(conflicted.running);

    expect(env.lastSaved()).toEqual({
      bindings: [
        binding("c-only-here", "chat-2"),
        binding("c-x", "chat-3"),
        binding("c1", "chat-1"),
      ],
      intents: [],
    });
    expect(
      env.adapter.latest().sent.find((line) => line.type === "ready"),
    ).toMatchObject({
      bindings: [
        { conversationId: "c-only-here", threadId: "chat-2" },
        { conversationId: "c-x", threadId: "chat-3" },
        { conversationId: "c1", threadId: "chat-1" },
      ],
      conflicts: ["chat-3"],
    });
    expect(conflicted.failure?._tag).toBe("ExternalConversationStopped");
    expect(runs).toEqual([]);
  });

  test("binds an existing chat once, and refuses a chat bound to another conversation or holding Claude's", async () => {
    const env = externalEnv({
      callers: ["parent-1", "chat-1", "chat-2"],
      conversationsHeld: ["chat-2"],
    });
    env.conversations.start();
    env.adapter.latest().say(hello());
    await settle();
    const bind = (id: number, conversationId: string, threadId: string) =>
      env.adapter.latest().say({
        type: "request",
        id,
        op: "bind_conversation",
        conversationId,
        threadId,
      });

    bind(1, "c1", "chat-1");
    bind(2, "c1", "chat-1");
    bind(3, "c2", "chat-1");
    bind(4, "c3", "chat-2");
    await until(() => env.adapter.latest().responses().length === 4);

    expect(
      env.adapter
        .latest()
        .responses()
        .map(({ outcome, reason }) => ({ outcome, reason })),
    ).toEqual([
      { outcome: "done", reason: undefined },
      { outcome: "done", reason: undefined },
      { outcome: "rejected", reason: "binding_conflict" },
      { outcome: "rejected", reason: "has_conversation" },
    ]);
  });

  test("holds a turn until the adapter declared its bindings, so a declared chat never runs as Claude", async () => {
    const env = externalEnv();
    const runs: string[] = [];
    const runtime = createExternalRuntime(
      innerRuntime(runs),
      env.conversations,
    );
    env.conversations.start();
    const turn = fakeTurn("turn-1", { threadId: "chat-old", text: "hi" });

    const ran = runtime.run(turn.running);
    await settle();
    env.adapter
      .latest()
      .say(hello([{ conversationId: "legacy", threadId: "chat-old" }]));
    await settle();
    env.adapter.latest().say({
      type: "turn_end",
      turnId: "turn-1",
      status: "completed",
    });
    await ran;

    expect(runs).toEqual([]);
    expect(env.adapter.latest().events("turn")).toEqual([
      expect.objectContaining({ conversationId: "legacy", kind: "input" }),
    ]);
  });
});

describe("createExternalConversations with two bridges", () => {
  test("answers each request only to the adapter of the bridge it came from, and sends only to sessions linked to that bridge", async () => {
    const a = externalEnv({ bridgeId: "bridge-a", owners: {} });
    const b = externalEnv({ bridgeId: "bridge-b", owners: { s1: "parent-b" } });
    a.conversations.start();
    b.conversations.start();
    a.adapter.latest().say(hello());
    b.adapter.latest().say(hello());
    await settle();

    a.adapter.latest().say({
      type: "request",
      id: 1,
      op: "cloud_send",
      sessionId: "s1",
      text: "to a",
    });
    b.adapter.latest().say({
      type: "request",
      id: 1,
      op: "cloud_send",
      sessionId: "s1",
      text: "to b",
    });
    await settle();

    expect(a.adapter.latest().responses()).toEqual([
      expect.objectContaining({
        id: 1,
        bridgeId: "bridge-a",
        outcome: "rejected",
        reason: "not_linked",
      }),
    ]);
    expect(b.adapter.latest().responses()).toEqual([
      expect.objectContaining({ id: 1, bridgeId: "bridge-b", outcome: "done" }),
    ]);
    expect({ a: a.sends, b: b.sends }).toEqual({
      a: [],
      b: [{ sessionId: "s1", text: "to b" }],
    });
  });

  test("never gives an answer to the adapter started after the one that asked, nor carries the request out again", async () => {
    const env = externalEnv({ owners: { s1: "parent-1" } });
    env.env.sendAnswer = { outcome: "unknown" };
    env.conversations.start();
    env.adapter.latest().say(hello());
    await settle();

    env.adapter.latest().say({
      type: "request",
      id: 1,
      op: "cloud_send",
      sessionId: "s1",
      text: "hi",
    });
    env.adapter.latest().exit();
    env.timers.runAll();
    env.adapter.latest().say(hello());
    await settle();

    expect(env.sends).toHaveLength(1);
    expect(env.adapter.processes[0]?.responses()).toEqual([]);
    expect(env.adapter.latest().responses()).toEqual([]);
    expect(env.logs).toContainEqual({
      event: "external_adapter",
      step: "answer_lost",
    });
  });
});

const until = async (done: () => boolean) => {
  for (let tries = 0; tries < 100 && !done(); tries++) await settle();
};
