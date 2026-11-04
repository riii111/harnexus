import { describe, expect, test } from "bun:test";

import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  prompt,
  reply,
  text,
  thinking,
  toolResult,
  toolUse,
} from "../../testing/session-record.ts";
import {
  answersAskWith,
  type CloudSessionState,
  sessionStateOf,
} from "./session-state.ts";

describe("sessionStateOf", () => {
  test.each<{
    name: string;
    records: SessionMessage[];
    expected: CloudSessionState["kind"];
  }>([
    { name: "no records yet", records: [], expected: "starting" },
    {
      name: "a tool call still running",
      records: [prompt("p1", "fix it"), bash("a1", "t1")],
      expected: "working",
    },
    {
      name: "a prompt not answered yet",
      records: [prompt("p1", "fix it")],
      expected: "working",
    },
    {
      name: "thinking marked as the end of the turn before its text",
      records: [
        prompt("p1", "fix it"),
        reply("a1", "m1", thinking("hmm"), "end_turn"),
      ],
      expected: "working",
    },
    {
      name: "a reply that ended the turn",
      records: [prompt("p1", "fix it"), endReply("a1", "done")],
      expected: "replied",
    },
    {
      name: "a reply that left a message scheduled",
      records: [
        prompt("p1", "watch CI"),
        reply(
          "a1",
          "m1",
          toolUse("t1", SEND_LATER, { delay_minutes: 30, message: "check" }),
          "tool_use",
          "2026-11-01T00:00:00Z",
        ),
        toolResult("r1", "t1", '{"trigger_id":"trig_01Abc"}'),
        endReply("a2", "will check"),
      ],
      expected: "resumes_later",
    },
    {
      name: "an interruption on claude.ai",
      records: [prompt("p1", "fix it"), bash("a1", "t1"), interruption("i1")],
      expected: "interrupted",
    },
    {
      name: "an interruption that left a question unanswered",
      records: [prompt("p1", "fix it"), ask("a1", "q1"), interruption("i1")],
      expected: "interrupted",
    },
    {
      name: "an API error Claude Code wrote",
      records: [prompt("p1", "fix it"), apiError("e1")],
      expected: "errored",
    },
  ])("is $expected for $name", ({ records, expected }) => {
    expect(sessionStateOf(records).kind).toBe(expected);
  });

  test.each<{ name: string; records: SessionMessage[] }>([
    {
      name: "the last record",
      records: [prompt("p1", "fix it"), ask("a1", "q1")],
    },
    {
      name: "another call of the same reply that has its result",
      records: [
        prompt("p1", "fix it"),
        ask("a1", "q1"),
        bash("a2", "t1"),
        toolResult("r1", "t1", "ok"),
      ],
    },
  ])("waits for the answer to a question asked in $name", ({ records }) => {
    expect(sessionStateOf(records)).toEqual({
      kind: "awaiting_input",
      ask: "question",
      toolUseId: "q1",
      input: QUESTION_INPUT,
    });
  });

  test("waits for a plan to be approved", () => {
    const state = sessionStateOf([
      prompt("p1", "plan it"),
      reply(
        "a1",
        "m1",
        toolUse("t1", "ExitPlanMode", { plan: "1. do it" }),
        "tool_use",
      ),
    ]);

    expect(state).toEqual({
      kind: "awaiting_input",
      ask: "plan",
      toolUseId: "t1",
      input: { plan: "1. do it" },
    });
  });

  test("goes back to work once the question is answered", () => {
    const records = [
      prompt("p1", "fix it"),
      ask("a1", "q1"),
      toolResult("r1", "q1", 'The user answered: "yes"'),
    ];

    expect(sessionStateOf(records.slice(0, 2)).kind).toBe("awaiting_input");
    expect(sessionStateOf(records).kind).toBe("working");
  });

  test("leaves a question a new prompt passed over behind", () => {
    const records = [
      prompt("p1", "fix it"),
      ask("a1", "q1"),
      prompt("p2", "never mind, do this"),
      bash("a2", "t1"),
    ];

    expect(sessionStateOf(records).kind).toBe("working");
  });
});

describe("answersAskWith", () => {
  const records = [
    prompt("p1", "fix it"),
    ask("a1", "q1"),
    bash("a2", "t1"),
    toolResult("r1", "t1", '="the second option".'),
    toolResult(
      "r2",
      "q1",
      'The user answered: "Which one?"="the second option". Read the answers carefully.',
    ),
  ];

  test.each([
    {
      name: "typed in the app",
      result:
        'The user answered: "Which one?"="the second option". Read the answers carefully.',
    },
    {
      name: "given on claude.ai's form among others",
      result:
        'Your questions have been answered: "Which one?"="the second option", "Why?"="speed". You can now continue.',
    },
  ])("takes the sent text as the answer $name", ({ result }) => {
    const answered = [ask("a1", "q1"), toolResult("r1", "q1", result)];

    expect(
      answersAskWith(answered, recordAt(answered, 1), "the second option"),
    ).toBe(true);
  });

  test("leaves another tool's result that holds the same text", () => {
    expect(
      answersAskWith(records, recordAt(records, 3), "the second option"),
    ).toBe(false);
    expect(
      answersAskWith(records, recordAt(records, 4), "the second option"),
    ).toBe(true);
  });

  test.each([
    { name: "another answer", sent: "the first option" },
    { name: "the start of a longer answer", sent: "the second" },
    { name: "the question it answers", sent: "Which one?" },
  ])(
    "leaves an answer that differs from the sent text, such as $name",
    ({ sent }) => {
      expect(answersAskWith(records, recordAt(records, 4), sent)).toBe(false);
      expect(
        answersAskWith(records, recordAt(records, 4), "the second option"),
      ).toBe(true);
    },
  );
});

const SEND_LATER = "mcp__claude-code-remote__send_later";

const QUESTION_INPUT = {
  questions: [
    {
      question: "Which one?",
      header: "Pick",
      multiSelect: false,
      options: [{ label: "first" }, { label: "second" }],
    },
  ],
};

const endReply = (uuid: string, value: string) =>
  reply(uuid, `m-${uuid}`, text(value), "end_turn");

const bash = (uuid: string, id: string) =>
  reply(uuid, `m-${uuid}`, toolUse(id, "Bash", { command: "ls" }), "tool_use");

const ask = (uuid: string, id: string) =>
  reply(
    uuid,
    `m-${uuid}`,
    toolUse(id, "AskUserQuestion", QUESTION_INPUT),
    "tool_use",
  );

const interruption = (uuid: string) =>
  prompt(uuid, "[Request interrupted by user]");

// Claude Code writes an API error as a reply from no model, which the SDK hands over without its error flag.
const apiError = (uuid: string): SessionMessage => {
  const record = reply(
    uuid,
    `m-${uuid}`,
    text("Login expired · Please run /login"),
    "stop_sequence",
  );
  return {
    ...record,
    message: { ...(record.message as object), model: "<synthetic>" },
  };
};

const recordAt = (records: SessionMessage[], index: number) => {
  const record = records[index];
  expect(record).toBeDefined();
  return record as SessionMessage;
};
