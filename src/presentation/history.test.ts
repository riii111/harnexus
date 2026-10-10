import { describe, expect, test } from "bun:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildHistory, replayHistory } from "./history.ts";
import type { ThreadItem, Turn } from "./protocol.ts";
import { RECOVERY_CONTEXT, RECOVERY_NOTICE } from "./recovery.ts";
import {
  conversation,
  prompt,
  reply,
  text,
  toolResult,
  toolUse,
} from "./testing/session-record.ts";

describe("buildHistory", () => {
  test.each([
    {
      name: "typed text",
      content: [text("continue")],
      expected: [{ type: "text", text: "continue", text_elements: [] }],
    },
    {
      name: "an image alone",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgo=",
          },
        },
      ],
      expected: [{ type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }],
    },
  ])("restores a recovery notice while keeping $name separate from the recovery instructions", ({
    content,
    expected,
  }) => {
    const [turn] = build([
      {
        ...prompt("recovery", ""),
        message: {
          role: "user",
          content: [...content, text(RECOVERY_CONTEXT)],
        },
      },
      reply("answer", "msg", text("done"), "end_turn"),
      prompt("normal", "next"),
    ]);
    expect(turn?.items.map(({ item }) => item.type)).toEqual([
      "userMessage",
      "agentMessage",
      "agentMessage",
    ]);
    expect(turn?.items[0]?.item).toMatchObject({ content: expected });
    expect(turn?.items[1]?.item).toMatchObject({
      text: RECOVERY_NOTICE,
      phase: "commentary",
    });
    expect(turn?.items[2]?.item).toMatchObject({
      text: "done",
      phase: "final_answer",
    });
  });

  test("replays the items a live turn shows, in the order Claude produced them", () => {
    const [first] = build(conversation());

    expect(first?.items.map(({ item }) => item.type)).toEqual([
      "userMessage",
      "reasoning",
      "commandExecution",
      "agentMessage",
    ]);
    expect(first?.items[0]?.item).toMatchObject({
      content: [{ type: "text", text: "list the files", text_elements: [] }],
    });
    expect(first?.items[2]?.item).toMatchObject({
      command: "ls",
      status: "completed",
      aggregatedOutput: "a.txt",
    });
    expect(first?.items[3]?.item).toMatchObject({
      text: "one file",
      phase: "final_answer",
    });
  });

  test("marks text before a tool call as commentary", () => {
    const [turn] = build([
      prompt("u1", "go"),
      reply("a1", "m1", text("checking"), "tool_use"),
      reply(
        "a2",
        "m1",
        toolUse("tool-1", "Bash", { command: "ls" }),
        "tool_use",
      ),
      toolResult("r1", "tool-1", "a.txt"),
      reply("a3", "m2", text("done"), "end_turn"),
    ]);

    const phases = turn?.items
      .map(({ item }) => item)
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.phase);
    expect(phases).toEqual(["commentary", "final_answer"]);
  });

  test("dates turns and items from the record's timestamps", () => {
    const [first] = build(conversation());

    expect(first?.turn).toMatchObject({
      startedAt: Date.parse("2026-09-27T00:00:00.000Z") / 1000,
      completedAt: Date.parse("2026-09-27T00:00:03.000Z") / 1000,
      durationMs: 3000,
    });
    expect(first?.items[2]).toMatchObject({
      startedAtMs: Date.parse("2026-09-27T00:00:01.000Z"),
      completedAtMs: Date.parse("2026-09-27T00:00:02.000Z"),
    });
  });

  test("leaves the times of a turn without timestamps unknown", () => {
    const [turn] = build([
      prompt("u1", "hi"),
      reply("a1", "m1", text("hello"), "end_turn"),
    ]);

    expect(turn?.turn).toMatchObject({
      startedAt: null,
      completedAt: null,
      durationMs: null,
    });
    expect(turn?.items.map(({ startedAtMs }) => startedAtMs)).toEqual([
      null,
      null,
    ]);
  });

  test("closes a turn followed by an interrupt notice as interrupted without opening another", () => {
    const history = build([
      prompt("u1", "go"),
      reply(
        "a1",
        "m1",
        toolUse("tool-1", "Bash", { command: "sleep 9" }),
        "tool_use",
      ),
      prompt("u2", "[Request interrupted by user for tool use]"),
      prompt("u3", "next"),
    ]);

    expect(history.map(({ turn }) => [turn.id, turn.status])).toEqual([
      ["harnexus-history-u1", "interrupted"],
      ["harnexus-history-u3", "completed"],
    ]);
    expect(history[0]?.items[1]?.item).toMatchObject({ status: "failed" });
  });

  test.each([
    { name: "a subagent's record", message: { parent_tool_use_id: "tool-9" } },
    { name: "a hidden record", message: { is_meta: true } },
  ])("skips $name", ({ message }) => {
    const history = build([
      prompt("u1", "go"),
      { ...prompt("u2", "hidden"), ...message },
      reply("a1", "m1", text("done"), "end_turn"),
    ]);

    expect(history.map(({ turn }) => turn.id)).toEqual(["harnexus-history-u1"]);
    expect(history[0]?.items.map(({ item }) => item.type)).toEqual([
      "userMessage",
      "agentMessage",
    ]);
  });

  test.each([
    { name: "command", text: "<command-name>/compact</command-name>" },
    {
      name: "caveat",
      text: "<local-command-caveat>Caveat: fixture</local-command-caveat>",
    },
    {
      name: "output",
      text: "<local-command-stdout>Compacted </local-command-stdout>",
    },
  ])("does not show a slash command's $name record as a prompt", ({
    text: recorded,
  }) => {
    const history = build([
      prompt("u1", "go"),
      reply("a1", "m1", text("done"), "end_turn"),
      prompt("u2", recorded),
      prompt("u3", "next"),
    ]);

    expect(history.map(({ turn }) => turn.id)).toEqual([
      "harnexus-history-u1",
      "harnexus-history-u3",
    ]);
    expect(history[0]?.items.map(({ item }) => item.type)).toEqual([
      "userMessage",
      "agentMessage",
    ]);
  });

  test("opens a turn for a reply recorded before any prompt", () => {
    const [turn] = build([reply("a1", "m1", text("resumed"), "end_turn")]);

    expect(turn?.turn.id).toBe("harnexus-history-a1");
    expect(turn?.items.map(({ item }) => item.type)).toEqual(["agentMessage"]);
  });

  test("shows only the typed text of a prompt the bridge attached files to", () => {
    const typed = "<skill> sample [$demo](/skills/demo/SKILL.md)";

    const [turn] = build([
      {
        ...prompt("u1", ""),
        message: {
          role: "user",
          content: [
            { type: "text", text: typed },
            { type: "text", text: "<skill>\nDo it.\n</skill>" },
          ],
        },
      },
    ]);

    expect(turn?.items[0]?.item).toMatchObject({
      content: [{ type: "text", text: typed }],
    });
  });

  test.each([
    {
      name: "with the typed text",
      content: [
        IMAGE_BLOCK,
        { type: "text", text: "what is wrong here" } as const,
      ],
      expected: [
        { type: "text", text: "what is wrong here", text_elements: [] },
        { type: "image", url: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    },
    {
      name: "alone",
      content: [IMAGE_BLOCK],
      expected: [{ type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }],
    },
  ])("shows an image Claude recorded in a prompt $name from the recorded copy", ({
    content,
    expected,
  }) => {
    const [turn] = build([
      { ...prompt("u1", ""), message: { role: "user", content } },
    ]);

    expect(turn?.items[0]?.item).toMatchObject({
      type: "userMessage",
      content: expected,
    });
  });

  test("returns no turns for an empty record", () => {
    expect(build([])).toEqual([]);
  });
});

describe("replayHistory", () => {
  test("streams each turn as a finished live turn, filling missing times from its turn or the given time", () => {
    const replayed = replayHistory(
      [
        {
          turn: TIMED_TURN,
          items: [
            {
              turnId: "turn-1",
              item: PROMPT_ITEM,
              startedAtMs: 1_001_000,
              completedAtMs: 1_002_000,
            },
            {
              turnId: "turn-1",
              item: COMPACTION_ITEM,
              startedAtMs: null,
              completedAtMs: null,
            },
          ],
        },
        { turn: UNTIMED_TURN, items: [] },
      ],
      "th-fixture",
      9_000_000,
    );

    expect(replayed).toEqual([
      {
        method: "turn/started",
        params: {
          threadId: "th-fixture",
          turn: {
            ...TIMED_TURN,
            items: [],
            itemsView: "full",
            status: "inProgress",
            completedAt: null,
            durationMs: null,
          },
        },
        emittedAtMs: 1_000_000,
      },
      {
        method: "item/started",
        params: {
          item: PROMPT_ITEM,
          threadId: "th-fixture",
          turnId: "turn-1",
          startedAtMs: 1_001_000,
        },
        emittedAtMs: 1_001_000,
      },
      {
        method: "item/completed",
        params: {
          item: PROMPT_ITEM,
          threadId: "th-fixture",
          turnId: "turn-1",
          completedAtMs: 1_002_000,
        },
        emittedAtMs: 1_002_000,
      },
      {
        method: "item/started",
        params: {
          item: COMPACTION_ITEM,
          threadId: "th-fixture",
          turnId: "turn-1",
          startedAtMs: 1_000_000,
        },
        emittedAtMs: 1_000_000,
      },
      {
        method: "item/completed",
        params: {
          item: COMPACTION_ITEM,
          threadId: "th-fixture",
          turnId: "turn-1",
          completedAtMs: 1_003_000,
        },
        emittedAtMs: 1_003_000,
      },
      {
        method: "turn/completed",
        params: { threadId: "th-fixture", turn: TIMED_TURN },
        emittedAtMs: 1_003_000,
      },
      {
        method: "turn/started",
        params: {
          threadId: "th-fixture",
          turn: { ...UNTIMED_TURN, itemsView: "full", status: "inProgress" },
        },
        emittedAtMs: 9_000_000,
      },
      {
        method: "turn/completed",
        params: { threadId: "th-fixture", turn: UNTIMED_TURN },
        emittedAtMs: 9_000_000,
      },
    ]);
  });
});

const PROMPT_ITEM: ThreadItem = {
  type: "userMessage",
  id: "item-1",
  clientId: null,
  content: [],
};

const COMPACTION_ITEM: ThreadItem = { type: "contextCompaction", id: "item-2" };

const TIMED_TURN: Turn = {
  id: "turn-1",
  items: [],
  itemsView: "summary",
  status: "completed",
  error: null,
  startedAt: 1_000,
  completedAt: 1_003,
  durationMs: 3_000,
};

const UNTIMED_TURN: Turn = {
  id: "turn-2",
  items: [],
  itemsView: "summary",
  status: "interrupted",
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
};

const IMAGE_BLOCK = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
} as const;

const build = (messages: SessionMessage[]) =>
  buildHistory(messages, { threadId: "th-claude", cwd: "/fixture/work" });
