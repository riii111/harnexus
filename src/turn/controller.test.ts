import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountInfo,
  type CanUseTool,
  createSdkMcpServer,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Result } from "better-result";
import { FileWriteFailed, writeFileAtomic } from "../boundary/fs.ts";
import { fakeClaude } from "../boundary/testing/fake-claude.ts";
import {
  type ClaudeSessionSettings,
  startClaudeSession,
} from "../claude/session.ts";
import { openThreadStore } from "../state/thread-store.ts";
import { createTurnController, type TurnEvent } from "./controller.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-turn-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("turn/start on a Claude thread", () => {
  test("answers with the turn, sends the prompt and completes from Claude's result", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, settings } = await harness([claude]);

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
  });

  test("logs a turn Claude completes as finished", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, events } = await harness([claude]);

    await completeTurn(turns, sent, claude, 10);

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

  test("keeps one Claude session for the thread across turns", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([claude]);

    await completeTurn(turns, sent, claude, 10);
    await completeTurn(turns, sent, claude, 11);

    expect(settings).toHaveLength(1);
    expect(turnsCompleted(sent)).toEqual(["completed", "completed"]);
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

  test("shows a tool that needed approval as declined", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "clean up"), undefined);
    await until(() => claude.started());
    const canUseTool = claude.options().canUseTool as CanUseTool;
    const decision = await canUseTool(
      "Bash",
      { command: "rm -rf build" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-1",
        requestId: "request-1",
      },
    );
    claude.emit(sdk(bashCall("tool-1")));
    claude.emit(sdk(toolError("tool-1")));
    claude.emit(sdk(success()));
    await until(() => turnCompleted(sent) !== undefined);

    expect(decision?.behavior).toBe("deny");
    const command = completedItems(sent).find(
      (item) => item.type === "commandExecution",
    );
    expect(command).toMatchObject({ status: "declined" });
  });

  test("fails the turn when the login is not a subscription", async () => {
    const claude = fakeClaude({ apiProvider: "bedrock" });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => turnCompleted(sent) !== undefined);

    expect(responseTo(sent, 10)?.result).toBeDefined();
    expect(turnCompleted(sent)).toMatchObject({ status: "failed" });
  });

  test("resumes the session after the stream fails", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings } = await harness([first, second]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.started());
    first.emit(sdk(answer("msg-1", "partial")));
    first.fail(new Error("socket closed"));
    await until(() => turnCompleted(sent) !== undefined);
    await completeTurn(turns, sent, second, 11);

    expect(turnsCompleted(sent)).toEqual(["failed", "completed"]);
    expect(first.closes()).toBe(1);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
  });
});

describe("session ids", () => {
  test("resumes from the session id Claude reported even when saving it failed", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    let writes = 0;
    const { turns, sent, settings, events } = await harness([first, second], {
      files: {
        writeState: async (target, content) =>
          ++writes === 1 ? writeFileAtomic(target, content) : diskFull(target),
      },
    });

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.started());
    first.emit(sdk(answer("msg-1", "partial")));
    first.fail(new Error("socket closed"));
    await until(() => turnCompleted(sent) !== undefined);
    await completeTurn(turns, sent, second, 11);

    expect(events).toContainEqual({
      event: "claude_turn",
      step: "session_not_saved",
      error: "StatePersistFailed",
    });
    expect(settings[1]).toMatchObject({ resume: "se-1" });
  });
});

describe("turn/interrupt", () => {
  test("replies before the turn completes as interrupted", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
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
    await until(() => claude.started());
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
    await until(() => first.started());
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
    await until(() => turnsCompleted(sent).length === 2);
    await completeTurn(turns, sent, second, 12);

    expect(responseTo(sent, 21)).toEqual({ id: 21, result: {} });
    expect(first.interrupts()).toBe(1);
    expect(turnsCompleted(sent)).toEqual([
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
    await until(() => turnsCompleted(sent).length === 2);

    expect(turnsCompleted(sent)).toEqual(["interrupted", "failed"]);
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
    await until(() => claude.started());
    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => claude.interrupts() === 1);
    await settle();
    turns.interruptTurn(interrupt(21, "turn-1"));
    await settle();

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

describe("refused requests", () => {
  test.each([
    { name: "non-text input", override: { input: [{ type: "image" }] } },
    { name: "a Codex model", override: { model: "gpt-fixture" } },
    { name: "another Claude model", override: { model: "claude-opus-5-5" } },
    {
      name: "another Claude model in the collaboration mode alone",
      override: {
        collaborationMode: {
          mode: "default",
          settings: { model: "claude-opus-5-5" },
        },
      },
    },
    {
      name: "plan mode",
      override: {
        collaborationMode: { mode: "plan", settings: { model: MODEL } },
      },
    },
    { name: "another working directory", override: { cwd: "/elsewhere" } },
  ])("refuses $name without starting Claude", async ({ override }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    const request = turnStart(10, "hello");
    turns.startTurn(
      { ...request, params: { ...request.params, ...override } },
      undefined,
    );
    await settle();

    expect(sent).toEqual([REFUSED(10)]);
    expect(claude.started()).toBe(false);
  });

  test("answers a rejected request with the given message", async () => {
    const { turns, sent } = await harness([]);

    turns.reject({ id: 12 }, "not yet");

    expect(sent).toEqual([
      { id: 12, error: { code: -32600, message: "not yet" } },
    ]);
  });

  test("refuses a turn asking for another directory that lost the race to register the thread", async () => {
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
    await until(() => responseTo(sent, 11) !== undefined);
    await until(() => claude.started());

    expect(responseTo(sent, 11)?.error.message).toBe(
      "changing the working directory of a Claude thread is not supported yet",
    );
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
  test("waits for the running turn and then continues the same Claude session", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings, events } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => responseTo(sent, 10) !== undefined);
    turns.startTurn(turnStart(11, "reply"), undefined);
    await settle();
    expect(responseTo(sent, 11)).toBeUndefined();
    claude.emit(sdk(answer("msg-1", "hi")));
    claude.emit(sdk(success()));
    await until(() => responseTo(sent, 11) !== undefined);
    claude.emit(sdk(answer("msg-2", "ok")));
    claude.emit(sdk(success()));
    await until(() => turnsCompleted(sent).length === 2);

    expect(responseTo(sent, 11)?.result.turn).toMatchObject({ id: "turn-2" });
    expect(turnsCompleted(sent)).toEqual(["completed", "completed"]);
    expect(await promptsUntil(claude, 2)).toEqual(["hello", "reply"]);
    expect(settings).toHaveLength(1);
    expect(events).toContainEqual({ event: "claude_turn", step: "queued" });
  });

  test("refuses a waiting turn once the bridge is closing", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    turns.startTurn(turnStart(11, "reply"), undefined);
    turns.closeAll();
    await until(() => responseTo(sent, 11) !== undefined);

    expect(turnsCompleted(sent)).toEqual(["failed"]);
    expect(responseTo(sent, 11)).toEqual({
      id: 11,
      error: { code: -32600, message: "the bridge is shutting down" },
    });
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
    await until(() => turnsCompleted(sent).length === 2);
    await settle();

    expect(responseTo(sent, 11)?.result).toBeDefined();
    expect(responseTo(sent, 12)).toEqual(DUPLICATE(12));
    expect(turnsCompleted(sent)).toEqual(["completed", "completed"]);
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
    expect(turnsCompleted(before.sent)).toEqual(["completed"]);
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
    expect(store.get(THREAD)?.runState).toBe("idle");
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

    expect(responseTo(sent, 10)?.error).toBeDefined();
    expect(responseTo(sent, 11)?.result.turn).toMatchObject({
      status: "inProgress",
    });
  });
});

describe("thread tools", () => {
  test("give each Claude session its own thread tool server and allowed tools", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings, links } = await harness([first, second]);

    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => first.started());
    first.fail(new Error("socket closed"));
    await until(() => turnCompleted(sent) !== undefined);
    await completeTurn(turns, sent, second, 11);

    expect(links).toEqual([THREAD, THREAD]);
    expect(settings[0]?.allowedTools).toEqual(ALLOWED_TOOLS);
    expect(Object.keys(settings[0]?.mcpServers ?? {})).toEqual(["codex_link"]);
    expect(settings[1]?.mcpServers?.codex_link).not.toBe(
      settings[0]?.mcpServers?.codex_link,
    );
  });

  test("leave the thread as outcome unknown after a turn with an undecided write and refuse the next turn", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, events } = await harness([claude], {
      unsettledWrite: () => true,
    });

    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState !== "running");
    turns.startTurn(turnStart(11, "again"), undefined);
    await until(() => responseTo(sent, 11) !== undefined);

    expect(store.get(THREAD)?.runState).toBe("outcomeUnknown");
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "outcome_unknown",
    });
    expect(responseTo(sent, 11)?.error.message).toContain("unknown outcome");
  });

  test("cancel their queued writes when the turn is stopped", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: [] });
    const { turns, cancels } = await harness([claude]);
    turns.startTurn(turnStart(10, "hello"), undefined);
    await until(() => claude.started());
    expect(cancels()).toBe(0);

    turns.interruptTurn(interrupt(20, "turn-1"));

    expect(cancels()).toBe(1);
  });

  test("cancel their queued writes when the turn finishes", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, cancels } = await harness([claude]);

    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState === "idle");

    expect(cancels()).toBe(1);
  });

  test("clear the run state after a turn whose writes were all decided", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store } = await harness([claude], {
      unsettledWrite: () => false,
    });

    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState !== "running");

    expect(store.get(THREAD)?.runState).toBe("idle");
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

const diskFull = async (target: string) =>
  Result.err(
    new FileWriteFailed({
      path: target,
      cause: new Error("disk full"),
      message: `cannot write ${target}`,
    }),
  );

// Leaves turn-1 ended by its result while the interrupt receipt is still held back.
const interruptBeforeReceipt = async (
  turns: ReturnType<typeof createTurnController>,
  sent: Sent[],
  claude: ReturnType<typeof fakeClaude>,
) => {
  turns.startTurn(turnStart(10, "hello"), undefined);
  await until(() => claude.started());
  turns.interruptTurn(interrupt(20, "turn-1"));
  claude.emit(
    sdk(result({ subtype: "error_during_execution", is_error: true })),
  );
  await until(() => turnCompleted(sent) !== undefined);
  expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
};

const createGate = () => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

const THREAD = "th-fixture-1";
const MODEL = "claude-sonnet-5";
const SUBSCRIPTION: AccountInfo = {
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};

// biome-ignore lint/suspicious/noExplicitAny: messages are checked by shape in each test.
type Sent = any;

const harness = async (
  fakes: ReturnType<typeof fakeClaude>[],
  {
    adopt = true,
    files = {},
    beforeStart = Promise.resolve(),
    onSend = () => {},
    unsettledWrite = () => false,
  }: {
    adopt?: boolean;
    files?: Parameters<typeof openThreadStore>[1];
    beforeStart?: Promise<void>;
    onSend?: (message: Sent) => void;
    unsettledWrite?: () => boolean;
  } = {},
) => {
  const opened = await openThreadStore(join(dir, "threads.json"), files);
  if (opened.isErr()) return expect.unreachable(opened.error.message);
  const store = opened.value;
  const sent: Sent[] = [];
  const events: TurnEvent[] = [];
  const settings: ClaudeSessionSettings[] = [];
  const links: string[] = [];
  let cancels = 0;
  let turnCount = 0;
  const turns = createTurnController({
    store,
    openLink: (threadId) => {
      links.push(threadId);
      return {
        server: createSdkMcpServer({ name: "codex_link", tools: [] }),
        allowedTools: ALLOWED_TOOLS,
        hasUnsettledWrite: unsettledWrite,
        cancelQueuedWrites: () => {
          cancels += 1;
        },
      };
    },
    send: (message) => {
      sent.push(message);
      onSend(message);
    },
    log: (event) => events.push(event),
    startSession: async (session) => {
      const fake = fakes[settings.length];
      settings.push(session);
      if (fake === undefined) return expect.unreachable("no fake Claude left");
      await beforeStart;
      return startClaudeSession(session, fake.runtime);
    },
    now: () => 1_700_000_000_000,
    newTurnId: () => `turn-${++turnCount}`,
  });
  if (adopt) turns.adopt(THREAD, { model: MODEL, cwd: dir });
  return {
    turns,
    sent,
    events,
    store,
    settings,
    links,
    cancels: () => cancels,
  };
};

const completeTurn = async (
  turns: ReturnType<typeof createTurnController>,
  sent: Sent[],
  claude: ReturnType<typeof fakeClaude>,
  id: number,
) => {
  const before = turnsCompleted(sent).length;
  turns.startTurn(turnStart(id, `prompt ${id}`), undefined);
  await until(() => responseTo(sent, id) !== undefined);
  claude.emit(sdk(answer(`msg-${id}`, "ok")));
  claude.emit(sdk(success()));
  await until(() => turnsCompleted(sent).length > before);
};

const turnStart = (id: number, text: string) => ({
  id,
  params: {
    threadId: THREAD,
    input: [{ type: "text", text, text_elements: [] }],
  } as Record<string, unknown>,
});

const withMessageId = (
  request: ReturnType<typeof turnStart>,
  clientUserMessageId: string,
) => ({ ...request, params: { ...request.params, clientUserMessageId } });

const interrupt = (id: number, turnId: string) => ({
  id,
  params: { threadId: THREAD, turnId },
});

// Long enough for a turn that was wrongly accepted to reach Claude.
const settle = () => Bun.sleep(20);

const DUPLICATE = (id: number) => ({
  id,
  error: {
    code: -32600,
    message: "this message was already delivered to the Claude thread",
  },
});

const ALLOWED_TOOLS = ["mcp__codex_link__read_thread"];

const REFUSED = (id: number) => ({
  id,
  error: { code: -32600, message: expect.any(String) },
});

const until = async (condition: () => boolean) => {
  for (let waited = 0; !condition(); waited += 2) {
    if (waited > 2000) return expect.unreachable("condition never held");
    await Bun.sleep(2);
  }
};

const firstPrompt = async (prompt: AsyncIterable<SDKUserMessage> | null) => {
  if (prompt === null) return null;
  const next = await prompt[Symbol.asyncIterator]().next();
  return next.done === true ? null : next.value.message.content;
};

const promptsUntil = async (
  claude: ReturnType<typeof fakeClaude>,
  count: number,
) => {
  const prompt = claude.prompt();
  if (prompt === null) return [];
  const iterator = prompt[Symbol.asyncIterator]();
  const texts: unknown[] = [];
  while (texts.length < count) {
    const next = await iterator.next();
    if (next.done === true) break;
    texts.push(next.value.message.content);
  }
  return texts;
};

const responseTo = (sent: Sent[], id: number) =>
  sent.find((message) => message.id === id);

const turnCompleted = (sent: Sent[]) =>
  sent.find((message) => message.method === "turn/completed")?.params.turn;

const turnsCompleted = (sent: Sent[]) =>
  sent
    .filter((message) => message.method === "turn/completed")
    .map((message) => message.params.turn.status);

const completedItems = (sent: Sent[]) =>
  sent
    .filter((message) => message.method === "item/completed")
    .map((message) => message.params.item);

const sdk = (message: object) =>
  ({
    session_id: "se-1",
    uuid: "uuid-fixture",
    ...message,
  }) as unknown as SDKMessage;

const answer = (id: string, text: string) => ({
  type: "assistant",
  message: { id, content: [{ type: "text", text }], stop_reason: "end_turn" },
  parent_tool_use_id: null,
});

const bashCall = (toolUseId: string) => ({
  type: "assistant",
  message: {
    id: "msg-tool",
    content: [
      {
        type: "tool_use",
        id: toolUseId,
        name: "Bash",
        input: { command: "rm -rf build" },
      },
    ],
    stop_reason: "tool_use",
  },
  parent_tool_use_id: null,
});

const toolError = (toolUseId: string) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "denied",
        is_error: true,
      },
    ],
  },
  parent_tool_use_id: null,
});

const success = () =>
  result({ subtype: "success", is_error: false, result: "done" });

const result = (fields: object) => ({
  type: "result",
  errors: [],
  permission_denials: [],
  ...fields,
});
