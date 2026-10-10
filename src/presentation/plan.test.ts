import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { NO_PLAN, renderPlan, type ThreadPlan } from "./plan.ts";

describe("renderPlan TodoWrite", () => {
  test("sends a successful list as the plan in app step statuses", () => {
    const out = feed(succeeded("tool-1", "TodoWrite", { todos: TODOS }));

    expect(out.sent).toEqual([
      {
        threadId: "th-1",
        turnId: "tu-1",
        explanation: null,
        plan: [
          { step: "Read the spec", status: "completed" },
          { step: "Write the code", status: "inProgress" },
          { step: "Run the tests", status: "pending" },
        ],
      },
    ]);
  });

  test("waits for the call's result before sending the plan", () => {
    const called = feed([call("tool-1", "TodoWrite", { todos: TODOS })]);

    const answered = feed([result("tool-1", "ok")], called.plan);

    expect(called.sent).toEqual([]);
    expect(steps(answered.sent)).toEqual([
      ["Read the spec", "Write the code", "Run the tests"],
    ]);
  });

  test("shows the list of a call only once it succeeds, never of a refused one", () => {
    const out = feed([
      call("tool-1", "TodoWrite", { todos: TODOS }),
      result("tool-1", "denied", { isError: true }),
      ...succeeded("tool-2", "TodoWrite", {
        todos: [{ content: "Only step", status: "pending" }],
      }),
    ]);

    expect(steps(out.sent)).toEqual([["Only step"]]);
  });

  test("sends the main conversation's list but not a subagent's", () => {
    const out = feed([
      ...succeeded("tool-9", "TodoWrite", {
        todos: [{ content: "Inner step", status: "pending" }],
      }).map((message) => ({ ...message, parent_tool_use_id: "tool-1" })),
      ...succeeded("tool-2", "TodoWrite", { todos: TODOS }),
    ]);

    expect(steps(out.sent)).toEqual([
      ["Read the spec", "Write the code", "Run the tests"],
    ]);
  });

  test("sends one plan for a call repeated across messages", () => {
    const repeated = call("tool-1", "TodoWrite", { todos: TODOS });

    const out = feed([repeated, repeated, result("tool-1", "ok"), repeated]);

    expect(out.sent).toHaveLength(1);
  });

  test.each([
    { name: "no todos", input: {} },
    {
      name: "an entry without content",
      input: { todos: [{ status: "pending" }] },
    },
    {
      name: "an unknown status",
      input: { todos: [{ content: "Read", status: "blocked" }] },
    },
    {
      name: "an inherited name as the status",
      input: { todos: [{ content: "Read", status: "toString" }] },
    },
    {
      name: "one bad entry among good ones",
      input: {
        todos: [
          { content: "Read", status: "completed" },
          { content: "Ship", status: 1 },
        ],
      },
    },
  ])("keeps the shown plan for $name once the call is answered", ({
    input,
  }) => {
    const shown = feed(succeeded("tool-1", "TodoWrite", { todos: TODOS }));

    const out = feed(succeeded("tool-2", "TodoWrite", input), shown.plan);

    expect(shown.sent).toHaveLength(1);
    expect(out.sent).toEqual([]);
    expect(out.plan).toEqual({ steps: shown.plan.steps, calls: {} });
  });
});

describe("renderPlan tasks", () => {
  test("follows created and updated tasks in creation order", () => {
    const out = feed([
      ...created("tool-1", "1", "Alpha step"),
      ...created("tool-2", "2", "Beta step"),
      ...updated("tool-3", { taskId: "1", status: "in_progress" }),
      ...updated("tool-4", { taskId: "1", status: "completed" }),
    ]);

    expect(out.sent.map((params) => params.plan)).toEqual([
      [{ step: "Alpha step", status: "pending" }],
      [
        { step: "Alpha step", status: "pending" },
        { step: "Beta step", status: "pending" },
      ],
      [
        { step: "Alpha step", status: "inProgress" },
        { step: "Beta step", status: "pending" },
      ],
      [
        { step: "Alpha step", status: "completed" },
        { step: "Beta step", status: "pending" },
      ],
    ]);
  });

  test("renames a task whose subject is updated", () => {
    const out = feed([
      ...created("tool-1", "1", "Alpha step"),
      ...updated("tool-2", { taskId: "1", subject: "Alpha, renamed" }),
    ]);

    expect(steps(out.sent).at(-1)).toEqual(["Alpha, renamed"]);
  });

  test("drops a deleted task from the plan", () => {
    const out = feed([
      ...created("tool-1", "1", "Alpha step"),
      ...created("tool-2", "2", "Beta step"),
      ...updated("tool-3", { taskId: "1", status: "deleted" }),
    ]);

    expect(steps(out.sent).at(-1)).toEqual(["Beta step"]);
  });

  test("reads a created task's id from the result text without structured output", () => {
    const out = feed([
      call("tool-1", "TaskCreate", { subject: "Alpha step", description: "" }),
      result("tool-1", "Task #7 created successfully: Alpha step"),
      ...updated("tool-2", { taskId: "7", status: "completed" }),
    ]);

    expect(out.sent.at(-1)?.plan).toEqual([
      { step: "Alpha step", status: "completed" },
    ]);
  });

  test("rebuilds the plan from a task list after the bridge started empty", () => {
    const out = feed([
      ...listed("tool-1", [
        { id: "1", subject: "Alpha step", status: "completed", blockedBy: [] },
        { id: "2", subject: "Beta step", status: "pending", blockedBy: [] },
      ]),
      ...updated("tool-2", { taskId: "2", status: "in_progress" }),
    ]);

    expect(out.sent.map((params) => params.plan)).toEqual([
      [
        { step: "Alpha step", status: "completed" },
        { step: "Beta step", status: "pending" },
      ],
      [
        { step: "Alpha step", status: "completed" },
        { step: "Beta step", status: "inProgress" },
      ],
    ]);
  });

  test("sends nothing when a task list matches the plan already shown", () => {
    const shown = feed(created("tool-1", "1", "Alpha step"));

    const out = feed(
      listed("tool-2", [
        { id: "1", subject: "Alpha step", status: "pending", blockedBy: [] },
      ]),
      shown.plan,
    );

    expect(shown.sent).toHaveLength(1);
    expect(out.sent).toEqual([]);
    expect(out.plan.calls).toEqual({});
  });

  test.each<{ name: string; input: object; output?: object }>([
    { name: "an unknown task", input: { taskId: "9", status: "completed" } },
    {
      name: "a failed update",
      input: { taskId: "1", status: "completed" },
      output: { success: false, taskId: "1", updatedFields: [] },
    },
  ])("leaves the plan unchanged for $name", ({ input, output }) => {
    const shown = feed(created("tool-1", "1", "Alpha step"));

    const out = feed(
      [
        call("tool-2", "TaskUpdate", input),
        result("tool-2", "Updated", { output }),
      ],
      shown.plan,
    );

    expect(shown.sent).toHaveLength(1);
    expect(out.sent).toEqual([]);
    expect(out.plan.calls).toEqual({});
  });

  test("empties a shown plan once when the conversation resets", () => {
    const shown = feed(created("tool-1", "1", "Alpha step"));

    const out = feed([RESET, RESET], shown.plan);

    expect(shown.sent).toHaveLength(1);
    expect(out.sent.map((params) => params.plan)).toEqual([[]]);
    expect(out.plan).toEqual(NO_PLAN);
  });

  test("forgets a call left unanswered when its turn ends", () => {
    const out = feed([
      call("tool-1", "TaskCreate", { subject: "Alpha step", description: "" }),
      { type: "result", subtype: "success" },
      result("tool-1", "Task #1 created successfully: Alpha step", {
        output: { task: { id: "1", subject: "Alpha step" } },
      }),
    ]);

    expect(out.sent).toEqual([]);
    expect(out.plan.calls).toEqual({});
  });
});

const feed = (messages: object[], start: ThreadPlan = NO_PLAN) => {
  let plan = start;
  const sent: PlanParams[] = [];
  for (const message of messages) {
    const rendered = renderPlan(plan, message as SDKMessage, TURN);
    plan = rendered.plan;
    if (rendered.notification?.method === "turn/plan/updated") {
      sent.push(rendered.notification.params);
    }
  }
  return { plan, sent };
};

type PlanParams = {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: { step: string; status: string }[];
};

const steps = (sent: PlanParams[]) =>
  sent.map((params) => params.plan.map((step) => step.step));

const succeeded = (id: string, name: string, input: object) => [
  call(id, name, input),
  result(id, "ok"),
];

const created = (id: string, taskId: string, subject: string) => [
  call(id, "TaskCreate", { subject, description: `${subject} task` }),
  result(id, `Task #${taskId} created successfully: ${subject}`, {
    output: { task: { id: taskId, subject } },
  }),
];

const updated = (
  id: string,
  input: { taskId: string; status?: string; subject?: string },
) => [
  call(id, "TaskUpdate", input),
  result(id, `Updated task #${input.taskId}`, {
    output: { success: true, taskId: input.taskId, updatedFields: [] },
  }),
];

const listed = (id: string, tasks: object[]) => [
  call(id, "TaskList", {}),
  result(id, "task list", { output: { tasks } }),
];

const call = (id: string, name: string, input: object) => ({
  type: "assistant",
  message: {
    id: `msg-${id}`,
    content: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
  },
  parent_tool_use_id: null,
});

const result = (
  id: string,
  content: string,
  {
    isError = false,
    output,
  }: { isError?: boolean; output?: object | undefined } = {},
) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: id, content, is_error: isError },
    ],
  },
  parent_tool_use_id: null,
  tool_use_result: output,
});

const RESET = {
  type: "conversation_reset",
  new_conversation_id: "conversation-2",
  trigger: "clear",
};

const TURN = { threadId: "th-1", turnId: "tu-1", now: 1700000000500 };

const TODOS = [
  { content: "Read the spec", status: "completed", activeForm: "Reading" },
  { content: "Write the code", status: "in_progress", activeForm: "Writing" },
  { content: "Run the tests", status: "pending", activeForm: "Running" },
];
