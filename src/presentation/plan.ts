import { isObject } from "../runtime/object.ts";
import type { TurnPlanStep } from "./protocol.ts";

// A TodoWrite call carries the whole list each time, so its input replaces the app's plan; a malformed list yields null so the app never shows a partial plan.
export const todoPlanOf = (use: {
  name: string;
  input: unknown;
}): TurnPlanStep[] | null => {
  if (use.name !== "TodoWrite" || !isObject(use.input)) return null;
  const { todos } = use.input;
  if (!Array.isArray(todos)) return null;
  const plan: TurnPlanStep[] = [];
  for (const todo of todos) {
    const step = stepOf(todo);
    if (step === null) return null;
    plan.push(step);
  }
  return plan;
};

const stepOf = (todo: unknown): TurnPlanStep | null => {
  if (!isObject(todo) || typeof todo.content !== "string") return null;
  const status =
    typeof todo.status === "string" ? STATUSES.get(todo.status) : undefined;
  return status === undefined ? null : { step: todo.content, status };
};

// A Map keeps inherited names such as "toString" from passing as a status.
const STATUSES = new Map<string, TurnPlanStep["status"]>([
  ["pending", "pending"],
  ["in_progress", "inProgress"],
  ["completed", "completed"],
]);
