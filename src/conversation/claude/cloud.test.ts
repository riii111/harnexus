import { describe, expect, test } from "bun:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "better-result";
import type { CloudSend } from "../../infra/claude/cloud.ts";
import type { CloudLink, ThreadRecord } from "../../infra/thread-store.ts";
import type { AppNotification } from "../../presentation/protocol.ts";
import {
  prompt,
  reply,
  text,
  toolResult,
  toolUse,
} from "../../presentation/testing/session-record.ts";
import {
  markInterrupting,
  type Rendered,
  renderTurnStarted,
  type TurnOutcome,
  type TurnState,
} from "../../presentation/turn.ts";
import { createGate } from "../testing/harness.ts";
import { refusalMessage } from "../thread-request.ts";
import type { RunningTurn, TurnInput, TurnRuntime } from "../turn-runtime.ts";
import {
  type CloudDeps,
  type CloudEvent,
  createCloudRuntime,
  serializeCloudEvent,
} from "./cloud.ts";

const CLOUD_ID = "session_01NfjPqrX1AK5RmKyV182VYD";

describe("createCloudRuntime child sessions", () => {
  const CHILD = "session_01NfjPqs5GNSgknfAaJ3mdYA";
  const started = (id: string) =>
    JSON.stringify({ ccr: { id, title: "worker" } });

  test("opens a chat for a session the linked one started after the app was shown, once", async () => {
    const env = linked({
      copies: [
        [
          prompt("p0", "earlier"),
          endReply("r0", "ok"),
          prompt("p1", "start a worker"),
          reply(
            "a1",
            "m1",
            toolUse("t1", "mcp__claude-code-remote__create_session", {}),
            "tool_use",
          ),
          toolResult("u1", "t1", started(CHILD)),
          endReply("a2", "started"),
        ],
      ],
      shown: "r0",
    });
    const turn = env.turn("start a worker");

    await env.runtime.run(turn.running);
    await env.tick();

    expect(env.children).toEqual([
      { parent: "thread-1", child: { sessionId: CHILD, title: "worker" } },
    ]);
  });

  test("opens nothing for the sessions a session started before /cloud linked it", async () => {
    const env = setup({
      copies: [
        [
          reply(
            "a1",
            "m1",
            toolUse("t1", "mcp__claude-code-remote__create_session", {}),
            "tool_use",
          ),
          toolResult("u1", "t1", started(CHILD)),
          endReply("a2", "started"),
        ],
      ],
    });
    const turn = env.turn(`/cloud ${CLOUD_ID}`);

    await env.runtime.run(turn.running);
    await env.tick();

    expect(env.links).toHaveLength(1);
    expect(env.children).toEqual([]);
  });

  test("tries a chat the app did not open again on a later copy", async () => {
    const env = linked({
      copies: [
        [
          prompt("p0", "earlier"),
          endReply("r0", "ok"),
          reply(
            "a1",
            "m1",
            toolUse("t1", "mcp__claude-code-remote__create_session", {}),
            "tool_use",
          ),
          toolResult("u1", "t1", started(CHILD)),
          endReply("a2", "started"),
        ],
      ],
      shown: "r0",
    });
    env.childOutcomes.push("not_sent");
    env.runtime.listen(() => true);

    await env.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await env.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(env.children.map((opened) => opened.child.sessionId)).toEqual([
      CHILD,
      CHILD,
    ]);
  });

  test.each([
    { name: "not sent", outcome: "not_sent", tries: 2 },
    { name: "without a project", outcome: "no_project", tries: 2 },
    { name: "of unknown result", outcome: "unknown", tries: 1 },
  ])("tries a chat the app answered $name again only when none may exist, after a turn moved the shown position past it", async ({
    outcome,
    tries,
  }) => {
    const env = linked({
      copies: [
        [
          prompt("p0", "earlier"),
          endReply("r0", "ok"),
          prompt("p1", "start a worker"),
          reply(
            "a1",
            "m1",
            toolUse("t1", "mcp__claude-code-remote__create_session", {}),
            "tool_use",
          ),
          toolResult("u1", "t1", started(CHILD)),
          endReply("a2", "started"),
        ],
      ],
      shown: "r0",
    });
    env.childOutcomes.push(outcome);
    env.runtime.listen(() => true);

    await env.runtime.run(env.turn("start a worker").running);
    await settle();
    expect(env.cloudOf("thread-1")?.shown).toBe("a2");
    await env.tick();
    await settle();
    await env.tick();
    await settle();

    expect(env.children.map((opened) => opened.child.sessionId)).toEqual(
      Array(tries).fill(CHILD),
    );
  });

  test("leaves a session started before the app was shown to the user", async () => {
    const env = linked({
      copies: [
        [
          reply(
            "a1",
            "m1",
            toolUse("t1", "mcp__claude-code-remote__create_session", {}),
            "tool_use",
          ),
          toolResult("u1", "t1", started(CHILD)),
          endReply("a2", "started"),
          prompt("p1", "hi"),
          endReply("a3", "hello"),
        ],
      ],
      shown: "a2",
    });
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);

    expect(env.children).toEqual([]);
  });
});

describe("createCloudRuntime /cloud", () => {
  test("links an empty thread to the session, then replays its conversation after the reply", async () => {
    const env = setup({
      copies: [[prompt("p1", "hello"), endReply("r1", "hi")]],
    });
    const turn = env.turn(`/cloud https://claude.ai/code/${CLOUD_ID}?from=cli`);

    await env.runtime.run(turn.running);

    expect(env.links).toEqual([
      {
        threadId: "thread-1",
        cloud: { sessionId: CLOUD_ID, shown: "r1" },
        copy: "copy-1",
      },
    ]);
    expect(turn.outcome).toEqual({ status: "completed" });
    expect(turn.texts().at(-1)).toContain("now shows the Cloud session");
    expect(env.sent).toEqual([{ replayOf: "copy-1" }]);
    expect(env.picked).toEqual(["thread-1"]);
    expect(env.events).toContainEqual({
      event: "claude_cloud",
      step: "linked",
    });
  });

  test("links a chat another chat opened with /cloud as its first message", async () => {
    const env = setup({
      copies: [[prompt("p1", "hello"), endReply("r1", "hi")]],
    });
    const turn = env.turn(`/cloud ${CLOUD_ID}`, {
      delegatedBy: "create_thread",
    });

    await env.runtime.run(turn.running);

    expect(env.links.map((link) => link.cloud.sessionId)).toEqual([CLOUD_ID]);
    expect(env.innerRuns).toEqual([]);
  });

  test("passes a /cloud another chat sent to an open chat to Claude", async () => {
    const env = setup({ copies: [] });
    const turn = env.turn(`/cloud ${CLOUD_ID}`, {
      delegatedBy: "send_message_to_thread",
    });

    await env.runtime.run(turn.running);

    expect(env.links).toEqual([]);
    expect(env.innerRuns).toEqual(["turn-1"]);
  });

  test.each([
    {
      name: "a text that is no session id",
      text: "/cloud nope",
      prepare: () => {},
      expected: "Send /cloud followed by",
    },
    {
      name: "a thread that already holds a conversation",
      text: `/cloud ${CLOUD_ID}`,
      prepare: (env: Env) => {
        env.sessionIds.set("thread-1", "local-1");
      },
      expected: "already holds a conversation",
    },
    {
      name: "a session another thread shows",
      text: `/cloud ${CLOUD_ID}`,
      prepare: (env: Env) => {
        env.owners.set(CLOUD_ID, "thread-9");
      },
      expected: "already shown in another thread",
    },
  ])("refuses $name without copying", async ({ text, prepare, expected }) => {
    const env = setup({ copies: [[prompt("p1", "hello")]] });
    prepare(env);
    const turn = env.turn(text);

    await env.runtime.run(turn.running);

    expect(turn.texts().at(-1)).toContain(expected);
    expect(env.copyCalls).toBe(0);
    expect(env.links).toEqual([]);
  });

  test("removes the copy when the link cannot be saved", async () => {
    const env = setup({ copies: [[prompt("p1", "hello")]] });
    env.linkFails = true;

    await env.runtime.run(env.turn(`/cloud ${CLOUD_ID}`).running);

    expect(env.discarded).toEqual(["copy-1"]);
    expect(env.sent).toEqual([]);
  });

  test("tells why a session could not be copied and leaves the thread unlinked", async () => {
    const env = setup({ copies: [] });
    env.copyFailure = "Session not found";
    const turn = env.turn(`/cloud ${CLOUD_ID}`);

    await env.runtime.run(turn.running);

    expect(turn.texts().at(-1)).toContain(
      "could not be copied: Session not found",
    );
    expect(env.links).toEqual([]);
  });
});

describe("createCloudRuntime turns", () => {
  test("sends the message and shows the reply until Claude ends its turn", async () => {
    const env = linked({
      copies: [
        [prompt("p0", "earlier"), endReply("r0", "ok")],
        [
          prompt("p0", "earlier"),
          endReply("r0", "ok"),
          prompt("p1", "fix the test"),
          reply(
            "a1",
            "m1",
            toolUse("t1", "Bash", { command: "bun test" }),
            "tool_use",
          ),
        ],
        [
          prompt("p0", "earlier"),
          endReply("r0", "ok"),
          prompt("p1", "fix the test"),
          reply(
            "a1",
            "m1",
            toolUse("t1", "Bash", { command: "bun test" }),
            "tool_use",
          ),
          toolResult("t1r", "t1", "1 pass"),
          endReply("a2", "fixed it"),
        ],
      ],
      shown: "r0",
    });
    const turn = env.turn("fix the test");

    await env.runtime.run(turn.running);

    expect(env.sends).toEqual([{ cloud: CLOUD_ID, text: "fix the test" }]);
    expect(turn.outcome).toEqual({ status: "completed" });
    expect(turn.texts()).toEqual(["fixed it"]);
    expect(env.events).toContainEqual({
      event: "claude_cloud",
      step: "sent",
      ms: 0,
    });
    expect(turn.itemTypes()).toContain("commandExecution");
    expect(env.runtime.recordOf("thread-1", "turn-1")).toBe("p1");
    expect(env.cloudOf("thread-1")).toEqual({
      sessionId: CLOUD_ID,
      shown: "a2",
    });
    expect(env.sessionIds.get("thread-1")).toBe("copy-3");
    // copy-4 was started before the reply's copy ended and is removed unread.
    expect(env.discarded).toEqual(["copy-0", "copy-1", "copy-2", "copy-4"]);
  });

  test("finds its prompt only after where the app was shown, so an earlier same text is not taken", async () => {
    const env = linked({
      copies: [
        [
          prompt("p0", "continue"),
          endReply("r0", "old answer"),
          prompt("p1", "continue"),
          endReply("r1", "new answer"),
        ],
      ],
      shown: "r0",
    });
    const turn = env.turn("continue");

    await env.runtime.run(turn.running);

    expect(turn.texts()).toEqual(["new answer"]);
    expect(env.runtime.recordOf("thread-1", "turn-1")).toBe("p1");
  });

  test("waits for a message sent while it runs and shows a prompt typed elsewhere", async () => {
    const env = linked({
      copies: [
        [prompt("p1", "first"), endReply("a1", "one")],
        [
          prompt("p1", "first"),
          endReply("a1", "one"),
          prompt("p2", "second"),
          prompt("p3", "typed on claude.ai"),
          endReply("a2", "two"),
        ],
      ],
      shown: null,
    });
    const turn = env.turn("first");
    const steered = createGate();
    env.wait = () => steered.promise;
    const running = env.runtime.run(turn.running);
    await env.untilSent(1);

    const refusal = await env.runtime.steer(turn.running, {
      text: "second",
      images: [],
    });
    steered.open();
    await running;

    expect(refusal).toBeNull();
    expect(env.sends.map((sent) => sent.text)).toEqual(["first", "second"]);
    expect(turn.texts()).toEqual(["one", "two"]);
    expect(turn.userTexts()).toEqual(["typed on claude.ai"]);
    expect(turn.outcome).toEqual({ status: "completed" });
  });

  test.each([
    {
      name: "a refused send fails the turn",
      answer: { kind: "rejected", message: "archived" } satisfies CloudSend,
      tag: "CloudSendRejected",
      unknown: false,
    },
    {
      name: "a send that may have landed marks the outcome unknown",
      answer: { kind: "unknown", message: "timeout" } satisfies CloudSend,
      tag: "CloudSendUnknown",
      unknown: true,
    },
  ])("$name without copying", async ({ answer, tag, unknown }) => {
    const env = linked({ copies: [], shown: null });
    env.sendAnswer = answer;
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);

    expect(turn.failure?._tag).toBe(tag);
    expect(turn.outcomeUnknown).toBe(unknown);
    expect(env.copyCalls).toBe(0);
  });

  test.each([
    { name: "an image", images: [{ path: "/tmp/a.png" }], compaction: false },
    { name: "a compaction", images: [], compaction: true },
  ])("refuses $name before sending", async ({ images, compaction }) => {
    const env = linked({ copies: [], shown: null });
    const turn = env.turn("hi", { images, compaction });

    await env.runtime.run(turn.running);

    expect(turn.failure?._tag).toBe("CloudInputUnsupported");
    expect(env.sends).toEqual([]);
  });

  test("stops waiting when the turn is stopped and says the session keeps working", async () => {
    const env = linked({ copies: [], shown: null });
    env.wait = (woken) => woken;
    const turn = env.turn("hi");
    const running = env.runtime.run(turn.running);
    await env.untilSent(1);

    env.runtime.interrupt(turn.running, false);
    await running;

    expect(turn.outcome).toEqual({ status: "interrupted" });
    expect(turn.texts().at(-1)).toContain("keeps working");
    expect(env.copyCalls).toBe(0);
  });

  test("does not send a turn stopped while it waited to start", async () => {
    const env = linked({ copies: [], shown: null });
    const turn = env.turn("hi");
    turn.stop();

    await env.runtime.run(turn.running);

    expect(env.sends).toEqual([]);
    expect(turn.outcome).toEqual({ status: "interrupted" });
  });

  test("stops after the send when the turn was stopped while sending", async () => {
    const env = linked({ copies: [], shown: null });
    const turn = env.turn("hi");
    env.duringSend = async () => {
      turn.stop();
    };

    await env.runtime.run(turn.running);

    expect(env.sends.map((sent) => sent.text)).toEqual(["hi"]);
    expect(turn.outcome).toEqual({ status: "interrupted" });
    expect(env.copyCalls).toBe(0);
  });

  test("keeps waiting for a message whose send has not answered when the first reply ends", async () => {
    const env = linked({
      copies: [
        [prompt("p1", "first"), endReply("a1", "one")],
        [prompt("p1", "first"), endReply("a1", "one")],
        [
          prompt("p1", "first"),
          endReply("a1", "one"),
          prompt("p2", "second"),
          endReply("a2", "two"),
        ],
      ],
      shown: null,
    });
    const turn = env.turn("first");
    let answerSecond = () => {};
    const steered = createGate();
    env.wait = () => steered.promise;
    const running = env.runtime.run(turn.running);
    await env.untilSent(1);
    env.duringSend = (text) =>
      text === "second"
        ? new Promise<void>((resolve) => {
            answerSecond = resolve;
          })
        : Promise.resolve();

    const steering = env.runtime.steer(turn.running, {
      text: "second",
      images: [],
    });
    steered.open();
    await env.untilCopied(2);
    expect(turn.outcome).toBeNull();
    answerSecond();
    await steering;
    await running;

    expect(turn.texts()).toEqual(["one", "two"]);
    expect(turn.outcome).toEqual({ status: "completed" });
  });

  test("takes a message that may have reached the session instead of refusing it, and leaves the outcome unknown", async () => {
    const env = linked({
      copies: [[prompt("p1", "first"), endReply("a1", "one")]],
      shown: null,
    });
    const turn = env.turn("first");
    const steered = createGate();
    env.wait = () => steered.promise;
    const running = env.runtime.run(turn.running);
    await env.untilSent(1);
    env.sendQueue.push({ kind: "unknown", message: "timeout" });

    const refusal = await env.runtime.steer(turn.running, {
      text: "second",
      images: [],
    });
    steered.open();
    await running;

    expect(refusal).toBeNull();
    expect(turn.outcomeUnknown).toBe(true);
    expect(turn.texts()).toContain(refusalMessage("cloud_send_unknown"));
    expect(turn.outcome).toEqual({ status: "completed" });
  });

  test("refuses a message the session refused and stops waiting for it", async () => {
    const env = linked({
      copies: [[prompt("p1", "first"), endReply("a1", "one")]],
      shown: null,
    });
    const turn = env.turn("first");
    const steered = createGate();
    env.wait = () => steered.promise;
    const running = env.runtime.run(turn.running);
    await env.untilSent(1);
    env.sendQueue.push({ kind: "rejected", message: "archived" });

    const refusal = await env.runtime.steer(turn.running, {
      text: "second",
      images: [],
    });
    steered.open();
    await running;

    expect(refusal).toBe("cloud_not_sent");
    expect(turn.outcome).toEqual({ status: "completed" });
  });

  test("stops waiting when the bridge closes", async () => {
    const env = linked({ copies: [], shown: null });
    env.wait = (woken) => woken;
    const turn = env.turn("hi");
    const running = env.runtime.run(turn.running);
    await env.untilSent(1);

    env.runtime.closeAll();
    await running;

    expect(turn.outcome).toEqual({ status: "interrupted" });
    expect(env.copyCalls).toBe(0);
  });

  test("keeps the previous copy while the new one could not be saved", async () => {
    const env = linked({
      copies: [[prompt("p1", "hi"), endReply("a1", "ok")]],
      shown: null,
    });
    env.saveFails = true;
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);

    expect(turn.outcome).toEqual({ status: "completed" });
    expect(env.discarded).toEqual([]);
  });

  test("ends the wait at the limit and leaves later replies to the idle copies", async () => {
    const env = linked({
      copies: [
        [
          prompt("p1", "long job"),
          reply("a1", "m1", text("working"), "tool_use"),
        ],
      ],
      shown: null,
      waitLimitMs: 0,
    });
    const turn = env.turn("long job");

    await env.runtime.run(turn.running);

    expect(turn.outcome).toEqual({ status: "completed" });
    expect(turn.texts().at(-1)).toContain("still working");
  });

  test("after the first copy, starts a copy every 1.5 seconds for 20 seconds, then waits 3 seconds between copies until a minute, then 10 seconds", async () => {
    const env = linked({
      copies: [
        [
          prompt("p1", "long job"),
          reply("a1", "m1", text("working"), "tool_use"),
        ],
      ],
      shown: null,
      waitLimitMs: 90_000,
    });
    // Copies take no time here, so the waits alone show when each copy starts.
    env.copyMs = 0;
    const turn = env.turn("long job");

    await env.runtime.run(turn.running);

    // A copy that ends at once still leaves 1.5 seconds before the next one starts.
    expect(env.waits).toEqual([
      0,
      ...Array<number>(14).fill(1_500),
      ...Array<number>(13).fill(3_000),
      ...Array<number>(3).fill(10_000),
    ]);
  });

  test("fails once copies have kept failing for 20 seconds, saying the message was delivered", async () => {
    const env = linked({ copies: [], shown: null });
    env.copyFailure = "network down";
    env.copyMs = 0;
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);

    expect(turn.failure?._tag).toBe("CloudCopyFailed");
    expect(turn.failure?.message).toContain("reached the Cloud session");
    // No copy has worked, so none overlap; each waits 3 seconds, and the first at least 20 seconds after the first failure ends the turn.
    expect(env.clock - 1_000).toBe(21_000);
    expect(env.waits).toEqual([0, ...Array<number>(7).fill(3_000)]);
  });

  test("shows a copy as soon as it ends while an older one still runs, then drops the older one", async () => {
    const env = linked({
      copies: [
        [prompt("p1", "hi")],
        [prompt("p1", "hi")],
        [prompt("p1", "hi"), endReply("a1", "ok")],
      ],
      shown: null,
    });
    let release = () => {};
    env.duringCopy = (call) =>
      call === 2
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);

    expect(turn.texts()).toEqual(["ok"]);
    expect(turn.outcome).toEqual({ status: "completed" });
    expect(env.sessionIds.get("thread-1")).toBe("copy-3");
    release();
    await env.untilDiscarded("copy-2");
  });

  test("keeps 1.5 seconds between copy starts while an older copy still runs", async () => {
    const env = linked({
      copies: [
        [prompt("p1", "hi")],
        [prompt("p1", "hi")],
        [prompt("p1", "hi")],
        [prompt("p1", "hi"), endReply("a1", "ok")],
      ],
      shown: null,
    });
    env.copyMs = 0;
    // A wait ends after a copy that ends at once, so the copy is read before the next one is due.
    env.wait = () => new Promise((resolve) => setTimeout(resolve, 0));
    const starts: number[] = [];
    let release = () => {};
    env.duringCopy = (call) => {
      starts.push(env.clock);
      return call === 2
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    };
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);
    release();

    expect(turn.outcome).toEqual({ status: "completed" });
    expect(
      starts.slice(1).map((at, index) => at - (starts[index] ?? 0)),
    ).toEqual([1_500, 1_500, 1_500]);
  });

  test("drops a copy that ends after a newer one was shown, while the turn goes on", async () => {
    const working = reply("a1", "m1", text("working"), "tool_use");
    const more = reply("a2", "m2", text("more"), "tool_use");
    const env = linked({
      copies: [
        [prompt("p1", "hi"), working],
        [prompt("p1", "hi")],
        [prompt("p1", "hi"), working, more],
        [prompt("p1", "hi"), working, more, endReply("a3", "done")],
      ],
      shown: null,
    });
    let release = () => {};
    env.duringCopy = (call) => {
      if (call === 2)
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      // The older copy ends while the newest one still runs.
      if (call === 4) {
        release();
        return new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      return Promise.resolve();
    };
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);

    expect(turn.texts()).toEqual(["working", "more", "done"]);
    expect(turn.userTexts()).toEqual([]);
    expect(env.discarded).toContain("copy-2");
  });

  test("takes a compacted session from a copy that does not overlap", async () => {
    const env = linked({
      copies: [[], [prompt("p1", "hi"), endReply("a1", "ok")]],
      shown: "gone",
    });
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);

    expect(turn.texts()).toEqual(["ok"]);
    expect(turn.outcome).toEqual({ status: "completed" });
  });

  test("drops an overlapping copy that lacks what was already shown", async () => {
    const env = linked({
      copies: [
        [prompt("p1", "hi"), reply("a1", "m1", text("working"), "tool_use")],
        [prompt("p1", "hi"), reply("a1", "m1", text("working"), "tool_use")],
        [prompt("p1", "hi")],
        [
          prompt("p1", "hi"),
          reply("a1", "m1", text("working"), "tool_use"),
          endReply("a2", "done"),
        ],
      ],
      shown: null,
    });
    let release = () => {};
    env.duringCopy = (call) =>
      call === 2
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);
    release();
    await env.untilDiscarded("copy-2");

    expect(turn.texts()).toEqual(["working", "done"]);
    expect(turn.outcome).toEqual({ status: "completed" });
    expect(env.discarded).toContain("copy-3");
    expect(env.cloudOf("thread-1")?.shown).toBe("a2");
  });

  test.each([
    {
      name: "did not report its turns",
      stopped: "unchecked" as const,
      step: "copy_unchecked",
    },
    {
      name: "ran a model turn",
      stopped: "ran_model" as const,
      step: "copy_ran_model",
    },
  ])("stops copying a thread whose copy $name", async ({ stopped, step }) => {
    const env = linked({ copies: [[prompt("p1", "hi")]], shown: null });
    env.copyStop = stopped;
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);

    expect(turn.failure?._tag).toBe("CloudCopyFailed");
    expect(env.copyCalls).toBe(1);
    expect(env.events).toContainEqual({ event: "claude_cloud", step });
  });

  test("waits for a message sent while the finished reply's copy was saved", async () => {
    const env = linked({
      copies: [
        [prompt("p1", "first"), endReply("a1", "one")],
        [
          prompt("p1", "first"),
          endReply("a1", "one"),
          prompt("p2", "second"),
          endReply("a2", "two"),
        ],
      ],
      shown: null,
    });
    const turn = env.turn("first");
    let steered: Promise<unknown> = Promise.resolve();
    env.duringSave = () => {
      env.duringSave = () => {};
      steered = env.runtime.steer(turn.running, { text: "second", images: [] });
    };

    await env.runtime.run(turn.running);
    await steered;

    expect(env.sends.map((sent) => sent.text)).toEqual(["first", "second"]);
    expect(turn.texts()).toEqual(["one", "two"]);
    expect(turn.outcome).toEqual({ status: "completed" });
  });

  test("passes a thread with no Cloud session to the runtime it wraps", async () => {
    const env = setup({ copies: [] });
    const turn = env.turn("hello");

    await env.runtime.run(turn.running);

    expect(env.innerRuns).toEqual(["turn-1"]);
    expect(env.sends).toEqual([]);
  });
});

describe("createCloudRuntime idle copies", () => {
  test("opens a turn of Claude's own for what the session did while no turn waited", async () => {
    const env = linked({
      copies: [
        [
          prompt("p1", "first"),
          endReply("a1", "one"),
          endReply("a2", "more on its own"),
        ],
      ],
      shown: "a1",
    });
    env.runtime.listen((threadId) => {
      env.ownStarts.push(threadId);
      return true;
    });

    await env.tick();
    const turn = env.turn("", { startedBy: "claude" });
    await env.runtime.run(turn.running);

    expect(env.ownStarts).toEqual(["thread-1"]);
    expect(turn.texts()).toEqual(["more on its own"]);
    expect(turn.outcome).toEqual({ status: "completed" });
    expect(env.cloudOf("thread-1")?.shown).toBe("a2");
    expect(env.copyCalls).toBe(1);
  });

  test("keeps the copy it reads when nothing is new", async () => {
    const env = linked({
      copies: [[prompt("p1", "first"), endReply("a1", "one")]],
      shown: "a1",
    });
    env.runtime.listen((threadId) => {
      env.ownStarts.push(threadId);
      return true;
    });

    await env.tick();

    expect(env.ownStarts).toEqual([]);
    expect(env.sessionIds.get("thread-1")).toBe("copy-0");
    expect(env.discarded).toEqual(["copy-1"]);
  });

  test("drops an idle copy made while a turn ran and ended", async () => {
    const env = linked({
      copies: [
        [prompt("p1", "first"), endReply("a1", "one"), endReply("o1", "bg")],
        [
          prompt("p1", "first"),
          endReply("a1", "one"),
          endReply("o1", "bg"),
          prompt("p2", "second"),
          endReply("a2", "two"),
        ],
      ],
      shown: "a1",
    });
    env.runtime.listen((threadId) => {
      env.ownStarts.push(threadId);
      return true;
    });
    let release = () => {};
    env.duringCopy = (call) =>
      call === 1
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();

    const idle = env.tick();
    await env.untilCopied(1);
    const turn = env.turn("second");
    await env.runtime.run(turn.running);
    release();
    await idle;

    expect(turn.texts()).toEqual(["two"]);
    expect(env.ownStarts).toEqual([]);
    expect(env.sessionIds.get("thread-1")).toBe("copy-2");
    expect(env.cloudOf("thread-1")?.shown).toBe("a2");
    expect(env.discarded).toContain("copy-1");
  });

  test("shows what a copy Claude compacted holds, since all of it came after the app was shown", async () => {
    const env = linked({
      copies: [[prompt("p9", "go on"), endReply("a9", "after")]],
      shown: "gone",
    });
    env.runtime.listen((threadId) => {
      env.ownStarts.push(threadId);
      return true;
    });

    await env.tick();
    const turn = env.turn("", { startedBy: "claude" });
    await env.runtime.run(turn.running);

    expect(env.ownStarts).toEqual(["thread-1"]);
    expect(turn.userTexts()).toEqual(["go on"]);
    expect(turn.texts()).toEqual(["after"]);
    expect(env.cloudOf("thread-1")?.shown).toBe("a9");
    expect(env.events).toContainEqual({
      event: "claude_cloud",
      step: "compacted",
    });
  });

  test("leaves a thread with a running turn alone", async () => {
    const env = linked({ copies: [[prompt("p1", "x")]], shown: null });
    env.runtime.listen(() => true);
    env.runtime.threadBusy("thread-1");

    await env.tick();

    expect(env.copyCalls).toBe(0);
  });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const endReply = (uuid: string, value: string) =>
  reply(uuid, `m-${uuid}`, text(value), "end_turn");

type Env = ReturnType<typeof setup>;

const setup = ({
  copies,
  waitLimitMs,
  link,
}: {
  copies: SessionMessage[][];
  waitLimitMs?: number;
  link?: CloudLink;
}) => {
  const sessionIds = new Map<string, string | null>();
  const clouds = new Map<string, CloudLink>();
  const owners = new Map<string, string>();
  const links: { threadId: string; cloud: CloudLink; copy: string }[] = [];
  const picked: string[] = [];
  const sends: { cloud: string; text: string }[] = [];
  const sent: object[] = [];
  const events: CloudEvent[] = [];
  const discarded: string[] = [];
  const innerRuns: string[] = [];
  const ownStarts: string[] = [];
  const contents = new Map<string, SessionMessage[]>();
  const ticks: (() => Promise<void>)[] = [];
  let sendWaiters: (() => boolean)[] = [];
  let copyWaiters: (() => boolean)[] = [];
  let turns = 0;
  if (link !== undefined) {
    clouds.set("thread-1", link);
    owners.set(link.sessionId, "thread-1");
    sessionIds.set("thread-1", "copy-0");
  }
  const env = {
    sessionIds,
    owners,
    links,
    picked,
    sends,
    sent,
    events,
    discarded,
    innerRuns,
    ownStarts,
    copyCalls: 0,
    childOutcomes: [] as string[],
    children: [] as {
      parent: string;
      child: { sessionId: string; title: string | null };
    }[],
    // The clock moves by the waits between copies, which are kept in order, and by each copy.
    clock: 1_000,
    waits: [] as number[],
    copyMs: 2_500,
    // Runs while that copy is being made and is waited for before it ends.
    duringCopy: async (_call: number) => {},
    // Set to make every copy say it may have run a model turn.
    copyStop: null as "ran_model" | "unchecked" | null,
    copyFailure: null as string | null,
    saveFails: false,
    linkFails: false,
    // Runs while a copy is being saved.
    duringSave: () => {},
    sendAnswer: { kind: "sent" } as CloudSend,
    // Answers for the next sends in order, before sendAnswer.
    sendQueue: [] as CloudSend[],
    // Runs when a send starts and is waited for before it answers.
    duringSend: async (_text: string) => {},
    cloudOf: (threadId: string) => clouds.get(threadId) ?? null,
    // The wait between copies; it ends at once unless a test holds it.
    wait: (_woken: Promise<void>): Promise<void> => Promise.resolve(),
    untilCopied: (count: number) =>
      new Promise<void>((resolve) => {
        if (env.copyCalls >= count) {
          resolve();
          return;
        }
        copyWaiters.push(() => {
          if (env.copyCalls < count) return false;
          resolve();
          return true;
        });
      }),
    // Settles once the runtime has handled the answer to that send.
    untilSent: (count: number) =>
      new Promise<void>((resolve) => {
        if (sends.length >= count) {
          setTimeout(resolve, 0);
          return;
        }
        sendWaiters.push(() => {
          if (sends.length < count) return false;
          resolve();
          return true;
        });
      }),
    // Settles once that copy has been removed.
    untilDiscarded: async (copy: string) => {
      while (!discarded.includes(copy)) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    tick: () => ticks.shift()?.() ?? Promise.resolve(),
    turn: (
      typed: string,
      options: {
        images?: readonly { path: string }[];
        compaction?: boolean;
        startedBy?: "app" | "claude";
        delegatedBy?: "create_thread" | "send_message_to_thread" | null;
      } = {},
    ) => fakeTurn(`turn-${++turns}`, typed, options),
    runtime: undefined as unknown as TurnRuntime<string>,
  };
  const deps: CloudDeps = {
    threads: {
      cloudOf: (threadId) => clouds.get(threadId) ?? null,
      cloudOwner: (cloudSessionId) => owners.get(cloudSessionId),
      cloudThreadIds: () => [...clouds.keys()],
      sessionIdOf: (threadId) => sessionIds.get(threadId) ?? null,
      takePicked: (threadId) => {
        picked.push(threadId);
        return true;
      },
      linkCloud: async (threadId, cloud, copy) => {
        if (env.linkFails) {
          return Result.err({ _tag: "StatePersistFailed" }) as never;
        }
        links.push({ threadId, cloud, copy });
        clouds.set(threadId, cloud);
        owners.set(cloud.sessionId, threadId);
        sessionIds.set(threadId, copy);
        return Result.ok({} as never);
      },
      setCloudCopy: async (threadId, copy, shown) => {
        env.duringSave();
        await Promise.resolve();
        sessionIds.set(threadId, copy);
        if (env.saveFails) {
          return Result.err({ _tag: "StatePersistFailed" }) as never;
        }
        const cloud = clouds.get(threadId);
        if (cloud !== undefined) clouds.set(threadId, { ...cloud, shown });
        return Result.ok({} as never);
      },
    },
    sendToCloud: async (cloud, sentText) => {
      const answer = env.sendQueue.shift() ?? env.sendAnswer;
      if (answer.kind !== "rejected") sends.push({ cloud, text: sentText });
      await env.duringSend(sentText);
      // Woken after the answer is handled, so a caller waiting for the send sees what the runtime did with it.
      setTimeout(() => {
        sendWaiters = sendWaiters.filter((wake) => !wake());
      }, 0);
      return answer;
    },
    copy: async () => {
      env.copyCalls += 1;
      const call = env.copyCalls;
      env.clock += env.copyMs;
      // A waiter stays until the count it waits for is reached.
      copyWaiters = copyWaiters.filter((wake) => !wake());
      await env.duringCopy(call);
      if (env.copyFailure !== null) {
        return Result.err({
          _tag: "CloudCopyFailed",
          stopped: null,
          message: env.copyFailure,
        });
      }
      const sessionId = `copy-${call}`;
      contents.set(sessionId, copies[Math.min(call, copies.length) - 1] ?? []);
      if (env.copyStop !== null) {
        return Result.err({
          _tag: "CloudCopyFailed",
          stopped: env.copyStop,
          message: "may have run a model turn",
        });
      }
      return Result.ok(sessionId);
    },
    readCopy: async (copy) => Result.ok(contents.get(copy) ?? []),
    discardCopy: async (copy) => {
      discarded.push(copy);
    },
    replayHistory: async (_threadId, copy) => [{ replayOf: copy }],
    openChild: async (parent, child) => {
      env.children.push({ parent, child });
      return env.childOutcomes.shift() ?? "done";
    },
    send: (message) => sent.push(message),
    log: (event) => events.push(event),
    now: () => env.clock,
    // A wait ends at the time it was due, so waits that run side by side do not add up.
    sleep: (ms, woken) => {
      env.waits.push(ms);
      const due = env.clock + ms;
      return env.wait(woken).then(() => {
        env.clock = Math.max(env.clock, due);
      });
    },
    schedule: (run) => {
      ticks.push(run);
      return () => {};
    },
    ...(waitLimitMs === undefined ? {} : { waitLimitMs }),
  };
  env.runtime = createCloudRuntime(fakeInner(innerRuns), deps);
  return env;
};

// A linked thread reads its first copy, named copy-0, until the first new copy replaces it.
const linked = (
  options: Parameters<typeof setup>[0] & { shown: string | null },
) => setup({ ...options, link: { sessionId: CLOUD_ID, shown: options.shown } });

const fakeInner = (runs: string[]): TurnRuntime<string> => ({
  compactPrompt: "/compact",
  closeSession: () => {},
  pauseMessages: () => () => {},
  recordOf: () => null,
  run: async (turn) => {
    runs.push(turn.turnId);
    turn.finish({ status: "completed" }, null);
  },
  steer: async () => null,
  interrupt: () => {},
  dropSession: () => {},
  noteFork: async () => {},
  threadBusy: () => {},
  threadIdle: () => {},
  listen: () => {},
  closeAll: () => {},
});

const RECORD: ThreadRecord = {
  threadId: "thread-1",
  sessionId: null,
  model: "claude-opus-5-5",
  effort: null,
  worktree: "/work/tree",
  messageIds: [],
  runState: "running",
};

const fakeTurn = (
  turnId: string,
  typed: string,
  {
    images = [],
    compaction = false,
    startedBy = "app",
    delegatedBy = null,
  }: {
    images?: readonly { path: string }[];
    compaction?: boolean;
    startedBy?: "app" | "claude";
    // A message another chat sent with this tool, wrapped as the app delivers it: a create_thread's as its <prompt>, a send_message_to_thread's as its <input>.
    delegatedBy?: "create_thread" | "send_message_to_thread" | null;
  },
) => {
  let state: TurnState = renderTurnStarted({
    threadId: "thread-1",
    turnId,
    cwd: "/work/tree",
    now: 0,
  }).state;
  const notifications: AppNotification[] = [];
  const delegated =
    delegatedBy === null
      ? null
      : delegatedBy === "create_thread"
        ? `<codex_delegation>\n  <source_thread_id>th-codex</source_thread_id>\n  <prompt>${typed}</prompt>\n</codex_delegation>`
        : `<codex_delegation>\n  <source_thread_id>th-codex</source_thread_id>\n  <input>${typed}</input>\n</codex_delegation>`;
  const input: TurnInput = {
    items:
      typed === "" || delegated !== null ? [] : [{ type: "text", text: typed }],
    toolOutput:
      delegated === null
        ? null
        : {
            name: delegatedBy ?? "",
            namespace: "codex_app",
            output: delegated,
          },
    text: delegated ?? typed,
    images: images as TurnInput["images"],
    permissionMode: "default",
    effort: null,
    startedBy,
  };
  const result = {
    outcome: null as TurnOutcome | null,
    failure: null as { _tag: string; message: string } | null,
    outcomeUnknown: false,
    running: undefined as unknown as RunningTurn<string>,
    completed: () =>
      notifications.flatMap((notification) =>
        notification.method === "item/completed"
          ? [notification.params.item]
          : [],
      ),
    texts: () =>
      result
        .completed()
        .flatMap((item) => (item.type === "agentMessage" ? [item.text] : [])),
    userTexts: () =>
      result
        .completed()
        .flatMap((item) =>
          item.type === "userMessage"
            ? item.content.flatMap((part) =>
                typeof part.text === "string" ? [part.text] : [],
              )
            : [],
        ),
    itemTypes: () => result.completed().map((item) => item.type),
    stop: () => {
      state = markInterrupting(state);
    },
  };
  const apply = (rendered: Rendered) => {
    state = rendered.state;
    notifications.push(...rendered.notifications);
  };
  result.running = {
    threadId: "thread-1",
    turnId,
    record: RECORD,
    model: "claude-opus-5-5",
    input,
    compaction,
    startedAtMs: 0,
    state: () => state,
    apply,
    finish: (outcome) => {
      result.outcome = outcome;
    },
    fail: (error) => {
      result.failure = error;
    },
    markOutcomeUnknown: () => {
      result.outcomeUnknown = true;
    },
    isOpen: () => result.outcome === null && result.failure === null,
    useLink: () => {},
    ask: async () => null,
  };
  return result;
};

describe("serializeCloudEvent", () => {
  test("keeps only the step, counts, durations and error tags", () => {
    expect(
      serializeCloudEvent({
        event: "claude_cloud",
        step: "copied",
        records: 3,
        ms: 900,
        ...{ session: CLOUD_ID, text: "secret" },
      } as CloudEvent),
    ).toEqual({ event: "claude_cloud", step: "copied", records: 3, ms: 900 });
    expect(
      serializeCloudEvent({
        event: "claude_cloud",
        step: "sent",
        ms: 1_200,
        ...{ session: CLOUD_ID, text: "secret" },
      } as CloudEvent),
    ).toEqual({ event: "claude_cloud", step: "sent", ms: 1_200 });
  });
});
