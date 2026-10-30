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
import type { RunningTurn, TurnInput, TurnRuntime } from "../turn-runtime.ts";
import {
  type CloudDeps,
  type CloudEvent,
  createCloudRuntime,
} from "./cloud.ts";

const CLOUD_ID = "session_01NfjPqrX1AK5RmKyV182VYD";

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
    expect(turn.itemTypes()).toContain("commandExecution");
    expect(env.runtime.recordOf("thread-1", "turn-1")).toBe("p1");
    expect(env.cloudOf("thread-1")).toEqual({
      sessionId: CLOUD_ID,
      shown: "a2",
    });
    expect(env.sessionIds.get("thread-1")).toBe("copy-3");
    expect(env.discarded).toEqual(["copy-0", "copy-1", "copy-2"]);
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
    env.sleepUntil = env.untilSteered;
    const running = env.runtime.run(turn.running);
    await env.untilSent(1);

    const refusal = await env.runtime.steer(turn.running, {
      text: "second",
      images: [],
    });
    env.steered();
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
    const env = linked({ copies: [], shown: null, sleepUntilWoken: true });
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
    env.sleepUntil = env.untilSteered;
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
    env.steered();
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
    env.sleepUntil = env.untilSteered;
    const running = env.runtime.run(turn.running);
    await env.untilSent(1);
    env.sendQueue.push({ kind: "unknown", message: "timeout" });

    const refusal = await env.runtime.steer(turn.running, {
      text: "second",
      images: [],
    });
    env.steered();
    await running;

    expect(refusal).toBeNull();
    expect(turn.outcomeUnknown).toBe(true);
    expect(turn.texts()).toContain(
      "That message may or may not have reached the Cloud session; check the session on claude.ai before sending it again.",
    );
    expect(turn.outcome).toEqual({ status: "completed" });
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

  test("fails after copies keep failing, saying the message was delivered", async () => {
    const env = linked({ copies: [], shown: null });
    env.copyFailure = "network down";
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);

    expect(turn.failure?._tag).toBe("CloudCopyFailed");
    expect(turn.failure?.message).toContain("reached the Cloud session");
    expect(env.copyCalls).toBe(3);
  });

  test("stops copying a thread whose copy did not report its turns", async () => {
    const env = linked({ copies: [[prompt("p1", "hi")]], shown: null });
    env.copyTurns = null;
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);

    expect(turn.failure?._tag).toBe("CloudCopyFailed");
    expect(env.copyCalls).toBe(1);
    expect(env.events).toContainEqual({
      event: "claude_cloud",
      step: "copy_unchecked",
    });
  });

  test("stops copying a thread whose copy ran a model turn", async () => {
    const env = linked({ copies: [[prompt("p1", "hi")]], shown: null });
    env.copyTurns = 1;
    const turn = env.turn("hi");

    await env.runtime.run(turn.running);

    expect(turn.failure?._tag).toBe("CloudCopyFailed");
    expect(env.copyCalls).toBe(1);
    expect(env.events).toContainEqual({
      event: "claude_cloud",
      step: "copy_ran_model",
    });
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

const endReply = (uuid: string, value: string) =>
  reply(uuid, `m-${uuid}`, text(value), "end_turn");

type Env = ReturnType<typeof setup>;

const setup = ({
  copies,
  sleepUntilWoken = false,
  waitLimitMs,
  link,
}: {
  copies: SessionMessage[][];
  sleepUntilWoken?: boolean;
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
  const ticks: (() => void)[] = [];
  let sendWaiters: (() => boolean)[] = [];
  let copyWaiters: (() => boolean)[] = [];
  let steered = () => {};
  const steeredOnce = new Promise<void>((resolve) => {
    steered = resolve;
  });
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
    copyTurns: 0 as number | null,
    copyFailure: null as string | null,
    saveFails: false,
    sendAnswer: { kind: "sent" } as CloudSend,
    // Answers for the next sends in order, before sendAnswer.
    sendQueue: [] as CloudSend[],
    // Runs when a send starts and is waited for before it answers.
    duringSend: async (_text: string) => {},
    cloudOf: (threadId: string) => clouds.get(threadId) ?? null,
    // Replaces the wait between copies while set.
    sleepUntil: null as (() => Promise<void>) | null,
    untilSteered: () => steeredOnce,
    steered: () => steered(),
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
    tick: async () => {
      const run = ticks.shift();
      run?.();
      // The tick runs its copies one after another; give them time to settle.
      for (let index = 0; index < 20; index++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    turn: (
      typed: string,
      options: {
        images?: readonly { path: string }[];
        compaction?: boolean;
        startedBy?: "app" | "claude";
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
        links.push({ threadId, cloud, copy });
        clouds.set(threadId, cloud);
        owners.set(cloud.sessionId, threadId);
        sessionIds.set(threadId, copy);
        return Result.ok({} as never);
      },
      setCloudCopy: async (threadId, copy, shown) => {
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
      // A waiter stays until the count it waits for is reached.
      copyWaiters = copyWaiters.filter((wake) => !wake());
      if (env.copyFailure !== null) {
        return Result.err({
          _tag: "CloudCopyFailed",
          message: env.copyFailure,
        });
      }
      const sessionId = `copy-${env.copyCalls}`;
      contents.set(
        sessionId,
        copies[Math.min(env.copyCalls, copies.length) - 1] ?? [],
      );
      return Result.ok({ sessionId, turns: env.copyTurns });
    },
    readCopy: async (copy) => Result.ok(contents.get(copy) ?? []),
    discardCopy: async (copy) => {
      discarded.push(copy);
    },
    replayHistory: async (_threadId, copy) => [{ replayOf: copy }],
    send: (message) => sent.push(message),
    log: (event) => events.push(event),
    now: () => 1_000,
    sleep: (_ms, woken) =>
      env.sleepUntil !== null
        ? env.sleepUntil()
        : sleepUntilWoken
          ? woken
          : Promise.resolve(),
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
  }: {
    images?: readonly { path: string }[];
    compaction?: boolean;
    startedBy?: "app" | "claude";
  },
) => {
  let state: TurnState = renderTurnStarted({
    threadId: "thread-1",
    turnId,
    cwd: "/work/tree",
    now: 0,
  }).state;
  const notifications: AppNotification[] = [];
  const input: TurnInput = {
    items: typed === "" ? [] : [{ type: "text", text: typed }],
    toolOutput: null,
    text: typed,
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
