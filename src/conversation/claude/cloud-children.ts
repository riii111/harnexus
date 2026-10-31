import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";

export type CloudChild = { sessionId: string; title: string | null };

// The tool a Cloud session starts another one with; only its results are read, so text a session merely writes or quotes never opens a chat.
const CREATE_SESSION = /(?:^|__)create_session$/;
const SESSION_ID = /^(?:session|cse)_[A-Za-z0-9]{8,64}$/;

// The sessions a Cloud session started whose result is at or after from, in the order its records hold them, each once; a call may sit in an earlier record than its result.
export const childSessionsIn = (
  records: readonly SessionMessage[],
  from = 0,
): CloudChild[] => {
  const calls = new Set<string>();
  const children = new Map<string, CloudChild>();
  for (const [index, record] of records.entries()) {
    for (const block of contentOf(record)) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        CREATE_SESSION.test(block.name)
      ) {
        calls.add(block.id);
      }
      if (
        block.type === "tool_result" &&
        index >= from &&
        typeof block.tool_use_id === "string" &&
        calls.has(block.tool_use_id) &&
        block.is_error !== true
      ) {
        const child = createdIn(block.content);
        if (child !== null && !children.has(child.sessionId)) {
          children.set(child.sessionId, child);
        }
      }
    }
  }
  return [...children.values()];
};

const contentOf = (record: SessionMessage): Record<string, unknown>[] => {
  const message = isObject(record) ? record.message : null;
  const content = isObject(message) ? message.content : null;
  return Array.isArray(content) ? content.filter(isObject) : [];
};

// create_session answers {"ccr":{"id":"session_…","title":…}}, as text.
const createdIn = (content: unknown): CloudChild | null => {
  const texts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((item) =>
            isObject(item) && typeof item.text === "string" ? [item.text] : [],
          )
        : [];
  for (const text of texts) {
    const parsed = parseJson(text);
    const ccr =
      parsed.isOk() && isObject(parsed.value) ? parsed.value.ccr : null;
    if (!isObject(ccr) || typeof ccr.id !== "string") continue;
    if (!SESSION_ID.test(ccr.id)) continue;
    return {
      sessionId: ccr.id,
      title:
        typeof ccr.title === "string" && ccr.title.trim() !== ""
          ? ccr.title.trim()
          : null,
    };
  }
  return null;
};
