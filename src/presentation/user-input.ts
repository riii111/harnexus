import { isObject } from "../runtime/object.ts";

export const REQUEST_USER_INPUT = "item/tool/requestUserInput";

export type UserInputTarget = {
  threadId: string;
  turnId: string;
  itemId: string;
};

export const userInputParams = <Q extends object>(
  target: UserInputTarget,
  questions: Q[],
) => ({
  threadId: target.threadId,
  turnId: target.turnId,
  itemId: target.itemId,
  questions,
  isBlocking: true,
  autoResolutionMs: null,
});

export const answerValuesOf = (answer: unknown, id: string): unknown[] => {
  if (!isObject(answer) || !isObject(answer.answers)) return [];
  const entry = answer.answers[id];
  // Each caller picks which answers it takes, since a picker reads one trimmed reply and an approval reads every non-empty one.
  return isObject(entry) && Array.isArray(entry.answers) ? entry.answers : [];
};
