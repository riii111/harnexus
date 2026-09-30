import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isObject } from "../runtime/object.ts";
import type { AppNotification, TurnPlanStep } from "./protocol.ts";

// Claude's tasks live as long as its session, across turns, so the plan is kept per thread; the bridge starts it empty and a TaskList result rebuilds it.
export type ThreadPlan = {
  readonly steps: readonly PlanStep[];
  readonly calls: Readonly<Record<string, PlanCall>>;
};

export const NO_PLAN: ThreadPlan = { steps: [], calls: {} };

// The plan changes only when a main-conversation call succeeds, so a refused or failed call never shows, and a subagent's list never replaces the thread's.
export const renderPlan = (
  plan: ThreadPlan,
  message: SDKMessage,
  turn: { threadId: string; turnId: string; now: number },
): { plan: ThreadPlan; notification: AppNotification | null } => {
  const next = nextPlan(plan, message);
  if (sameSteps(plan.steps, next.steps)) {
    return { plan: next, notification: null };
  }
  return {
    plan: next,
    notification: {
      method: "turn/plan/updated",
      params: {
        threadId: turn.threadId,
        turnId: turn.turnId,
        explanation: null,
        plan: next.steps.map(({ step, status }) => ({ step, status })),
      },
      emittedAtMs: turn.now,
    },
  };
};

// A TodoWrite list has no ids, so its steps cannot be the target of a TaskUpdate.
type PlanStep = TurnPlanStep & { id: string | null };

type PlanCall = { name: string; input: unknown };

// Only main-conversation calls are recorded, so a result is matched to one of them by its tool use id alone.
const nextPlan = (plan: ThreadPlan, message: SDKMessage): ThreadPlan => {
  if (message.type === "assistant" && message.parent_tool_use_id === null) {
    return { ...plan, calls: { ...plan.calls, ...planCallsOf(message) } };
  }
  if (message.type === "user") return applyResults(plan, message);
  // A call left without a result when its turn ended never completes.
  if (message.type === "result") return { ...plan, calls: {} };
  // A reset such as /clear starts a conversation whose task list is empty.
  if (message.type === "conversation_reset") return NO_PLAN;
  return plan;
};

const planCallsOf = (
  message: Extract<SDKMessage, { type: "assistant" }>,
): Record<string, PlanCall> => {
  const calls: Record<string, PlanCall> = {};
  for (const block of message.message.content) {
    if (block.type === "tool_use" && PLAN_TOOLS.has(block.name)) {
      calls[block.id] = { name: block.name, input: block.input };
    }
  }
  return calls;
};

const applyResults = (
  plan: ThreadPlan,
  message: Extract<SDKMessage, { type: "user" }>,
): ThreadPlan => {
  const { content } = message.message;
  if (typeof content === "string") return plan;
  const results = content.filter((block) => block.type === "tool_result");
  // The structured output belongs to a single tool, so it is used only when the message answers one call.
  const output = results.length === 1 ? message.tool_use_result : undefined;
  let steps = plan.steps;
  const calls = { ...plan.calls };
  for (const result of results) {
    const call = calls[result.tool_use_id];
    if (call === undefined) continue;
    delete calls[result.tool_use_id];
    if (result.is_error !== true) {
      steps = applyCall(steps, call, output, result.content) ?? steps;
    }
  }
  return { steps, calls };
};

const applyCall = (
  steps: readonly PlanStep[],
  call: PlanCall,
  output: unknown,
  content: unknown,
): readonly PlanStep[] | null => {
  switch (call.name) {
    case "TodoWrite":
      return todoStepsOf(call.input);
    case "TaskCreate":
      return createTask(steps, call.input, output, content);
    case "TaskUpdate":
      return updateTask(steps, call.input, output);
    case "TaskList":
      return listedStepsOf(output);
    default:
      return null;
  }
};

// A TodoWrite call carries the whole list each time, so a malformed list yields null and the app never shows a partial plan.
const todoStepsOf = (input: unknown): PlanStep[] | null => {
  if (!isObject(input) || !Array.isArray(input.todos)) return null;
  const steps: PlanStep[] = [];
  for (const todo of input.todos) {
    if (!isObject(todo) || typeof todo.content !== "string") return null;
    const status = statusOf(todo.status);
    if (status === undefined) return null;
    steps.push({ id: null, step: todo.content, status });
  }
  return steps;
};

// The task id comes only from the result, which states it in its text when no structured output is at hand.
const createTask = (
  steps: readonly PlanStep[],
  input: unknown,
  output: unknown,
  content: unknown,
): PlanStep[] | null => {
  if (!isObject(input) || typeof input.subject !== "string") return null;
  const id = createdIdOf(output) ?? createdIdInText(content);
  if (id === null) return null;
  return [
    ...steps.filter((step) => step.id !== id),
    { id, step: input.subject, status: "pending" },
  ];
};

const updateTask = (
  steps: readonly PlanStep[],
  input: unknown,
  output: unknown,
): PlanStep[] | null => {
  if (!isObject(input) || typeof input.taskId !== "string") return null;
  if (isObject(output) && output.success === false) return null;
  const { taskId, subject } = input;
  if (input.status === "deleted") {
    return steps.filter((step) => step.id !== taskId);
  }
  const status = statusOf(input.status);
  return steps.map((step) =>
    step.id === taskId
      ? {
          ...step,
          ...(typeof subject === "string" && { step: subject }),
          ...(status !== undefined && { status }),
        }
      : step,
  );
};

const listedStepsOf = (output: unknown): PlanStep[] | null => {
  if (!isObject(output) || !Array.isArray(output.tasks)) return null;
  const steps: PlanStep[] = [];
  for (const task of output.tasks) {
    if (
      !isObject(task) ||
      typeof task.id !== "string" ||
      typeof task.subject !== "string"
    ) {
      return null;
    }
    const status = statusOf(task.status);
    if (status === undefined) return null;
    steps.push({ id: task.id, step: task.subject, status });
  }
  return steps;
};

const createdIdOf = (output: unknown): string | null =>
  isObject(output) &&
  isObject(output.task) &&
  typeof output.task.id === "string"
    ? output.task.id
    : null;

const createdIdInText = (content: unknown): string | null =>
  typeof content === "string"
    ? (CREATED_TEXT.exec(content)?.[1] ?? null)
    : null;

const statusOf = (status: unknown) =>
  typeof status === "string" ? STATUSES.get(status) : undefined;

const sameSteps = (a: readonly PlanStep[], b: readonly PlanStep[]) =>
  a.length === b.length &&
  a.every(
    (step, index) =>
      step.step === b[index]?.step && step.status === b[index]?.status,
  );

const PLAN_TOOLS = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
]);

// A Map keeps inherited names such as "toString" from passing as a status.
const STATUSES = new Map<string, TurnPlanStep["status"]>([
  ["pending", "pending"],
  ["in_progress", "inProgress"],
  ["completed", "completed"],
]);

const CREATED_TEXT = /^Task #(\S+) created successfully/;
