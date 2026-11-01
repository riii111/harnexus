import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";

// A review harnexus-task review finished in a Cloud session, as its output names it.
export type CloudReview = {
  // The tool result that holds it, so each review is taken once.
  key: string;
  reviewer: string;
  verdict: string | null;
  taskId: string | null;
  head: string | null;
  answer: string;
};

// The reviews whose output a Cloud session read at or after from, in order, each once; the output may be read from a file it was written to.
export const reviewsIn = (
  records: readonly SessionMessage[],
  from = 0,
): CloudReview[] => {
  const reviews = new Map<string, CloudReview>();
  for (const [index, record] of records.entries()) {
    if (index < from) continue;
    for (const block of contentOf(record)) {
      if (block.type !== "tool_result" || block.is_error === true) continue;
      if (typeof block.tool_use_id !== "string") continue;
      for (const text of textsOf(block.content)) {
        const review = reviewOf(text, block.tool_use_id);
        if (review !== null && !reviews.has(review.key))
          reviews.set(review.key, review);
      }
    }
  }
  return [...reviews.values()];
};

const contentOf = (record: SessionMessage): Record<string, unknown>[] => {
  const message = isObject(record) ? record.message : null;
  const content = isObject(message) ? message.content : null;
  return Array.isArray(content) ? content.filter(isObject) : [];
};

const textsOf = (content: unknown) =>
  typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((item) =>
          isObject(item) && typeof item.text === "string" ? [item.text] : [],
        )
      : [];

// The output is harnexus-task's JSON, alone or with other lines around it, and with line numbers when a file was read.
const reviewOf = (text: string, key: string): CloudReview | null => {
  if (!text.includes('"reviewer"')) return null;
  const plain = text.replace(LINE_NUMBER, "");
  const start = plain.indexOf("{");
  const end = plain.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  const parsed = parseJson(plain.slice(start, end + 1));
  if (parsed.isErr() || !isObject(parsed.value)) return null;
  const output = parsed.value;
  if (
    output.status !== "completed" ||
    typeof output.reviewer !== "string" ||
    typeof output.answer !== "string" ||
    output.answer.trim() === ""
  )
    return null;
  return {
    key,
    reviewer: output.reviewer,
    verdict: textOrNull(output.verdict),
    taskId: textOrNull(output.taskId),
    head: textOrNull(output.head),
    answer: output.answer,
  };
};

const textOrNull = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : null;

const LINE_NUMBER = /^ *\d+\t/gm;
