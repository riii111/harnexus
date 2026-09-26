import { describe, expect, test } from "bun:test";
import type { ToolItem } from "../render/protocol.ts";
import { promptFor, type ToolCall } from "./permission.ts";

describe("promptFor requests", () => {
  test.each<{ name: string; call: ToolCall; expected: string }>([
    {
      name: "a command",
      call: call("Bash", { command: "ls" }, COMMAND),
      expected: "item/commandExecution/requestApproval",
    },
    {
      name: "a file change",
      call: call("Edit", { file_path: "/w/a.ts" }, FILE_CHANGE),
      expected: "item/fileChange/requestApproval",
    },
    {
      name: "a question",
      call: call("AskUserQuestion", { questions: [QUESTION] }, null),
      expected: "item/tool/requestUserInput",
    },
    {
      name: "a plan",
      call: call("ExitPlanMode", { plan: "1. edit" }, null),
      expected: "item/tool/requestUserInput",
    },
    {
      name: "any other tool",
      call: call("WebFetch", { url: "https://example.com" }, null),
      expected: "item/tool/requestUserInput",
    },
    {
      name: "a question the tool cannot read",
      call: call("AskUserQuestion", { questions: "which?" }, null),
      expected: "item/tool/requestUserInput",
    },
  ])("asks the app about $name with $expected", ({ call, expected }) => {
    expect(promptFor(call, TARGET).method).toBe(expected);
  });

  test("points a command approval at the command's item without session-wide choices", () => {
    const prompt = promptFor(
      call("Bash", { command: "ls" }, COMMAND, "outside the project"),
      TARGET,
    );

    expect(prompt.params).toMatchObject({
      threadId: "th-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 1_700_000_000_000,
      command: "ls",
      cwd: "/w",
      reason: "outside the project",
      availableDecisions: ["accept", "decline", "cancel"],
    });
  });

  test("asks Claude's questions with their options and room for another answer", () => {
    const prompt = promptFor(
      call("AskUserQuestion", { questions: [QUESTION] }, null),
      TARGET,
    );

    expect(prompt.params.questions).toEqual([
      {
        id: "question-1",
        header: "Library",
        question: "Which library?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "zod", description: "schemas" },
          { label: "valibot", description: "" },
        ],
      },
    ]);
  });
});

describe("promptFor decisions", () => {
  test.each([
    { name: "accept", decision: "accept", expected: "allow" },
    {
      name: "accept for the session",
      decision: "acceptForSession",
      expected: "allow",
    },
    {
      name: "a policy amendment",
      decision: {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: ["ls"] },
      },
      expected: "allow",
    },
    { name: "decline", decision: "decline", expected: "deny" },
    { name: "cancel", decision: "cancel", expected: "deny" },
    {
      name: "a network amendment",
      decision: { applyNetworkPolicyAmendment: {} },
      expected: "deny",
    },
  ])("answers $expected to a command approval of $name", ({
    decision,
    expected,
  }) => {
    const prompt = promptFor(call("Bash", { command: "ls" }, COMMAND), TARGET);

    expect(prompt.decide({ decision }).behavior).toBe(expected);
  });

  test.each([
    { name: "no answer", answer: null },
    { name: "an answer without a decision", answer: {} },
  ])("denies a file change approval with $name", ({ answer }) => {
    const prompt = promptFor(call("Write", {}, FILE_CHANGE), TARGET);

    expect(prompt.decide(answer)).toEqual({
      behavior: "deny",
      message: expect.stringContaining("no answer"),
    });
  });

  test("returns the chosen answers keyed by question text", () => {
    const input = { questions: [QUESTION, { ...QUESTION, question: "Why?" }] };
    const prompt = promptFor(call("AskUserQuestion", input, null), TARGET);

    const decision = prompt.decide({
      answers: {
        "question-1": { answers: ["zod", "valibot"] },
        "question-2": { answers: ["speed"] },
      },
    });

    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: { "Which library?": "zod, valibot", "Why?": "speed" },
      },
    });
  });

  test("denies questions left unanswered", () => {
    const prompt = promptFor(
      call("AskUserQuestion", { questions: [QUESTION] }, null),
      TARGET,
    );

    expect(
      prompt.decide({ answers: { "question-1": { answers: [] } } }).behavior,
    ).toBe("deny");
  });

  test("leaves plan mode when the plan is approved", () => {
    const prompt = promptFor(
      call("ExitPlanMode", { plan: "1. edit" }, null),
      TARGET,
    );

    expect(
      prompt.decide({ answers: { plan: { answers: ["Approve"] } } }),
    ).toEqual({
      behavior: "allow",
      updatedPermissions: [
        { type: "setMode", mode: "default", destination: "session" },
      ],
    });
  });

  test.each([
    {
      name: "keeping planning",
      chosen: "Keep planning",
      expected: "keep planning",
    },
    { name: "feedback", chosen: "split step 2", expected: "split step 2" },
  ])("stays in plan mode with $name", ({ chosen, expected }) => {
    const prompt = promptFor(call("ExitPlanMode", {}, null), TARGET);

    expect(prompt.decide({ answers: { plan: { answers: [chosen] } } })).toEqual(
      {
        behavior: "deny",
        message: expect.stringContaining(expected),
      },
    );
  });

  test.each([
    { name: "Allow", expected: "allow" },
    { name: "Deny", expected: "deny" },
  ])("answers $expected when the user picks $name for another tool", ({
    name,
    expected,
  }) => {
    const prompt = promptFor(call("WebFetch", {}, null), TARGET);

    expect(
      prompt.decide({ answers: { approval: { answers: [name] } } }).behavior,
    ).toBe(expected);
  });
});

const call = (
  toolName: string,
  input: Record<string, unknown>,
  item: ToolItem | null,
  reason?: string,
): ToolCall => ({ toolName, input, item, title: undefined, reason });

const TARGET = {
  threadId: "th-1",
  turnId: "turn-1",
  itemId: "item-1",
  now: 1_700_000_000_000,
};

const COMMAND: ToolItem = {
  type: "commandExecution",
  id: "item-1",
  pluginId: null,
  scriptPath: null,
  command: "ls",
  cwd: "/w",
  processId: null,
  source: "agent",
  status: "inProgress",
  commandActions: [{ type: "unknown", command: "ls" }],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
};

const FILE_CHANGE: ToolItem = {
  type: "fileChange",
  id: "item-1",
  changes: [],
  status: "inProgress",
};

const QUESTION = {
  question: "Which library?",
  header: "Library",
  options: [{ label: "zod", description: "schemas" }, { label: "valibot" }],
  multiSelect: false,
};
