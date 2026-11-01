import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";

export type CloudChild = { sessionId: string; title: string | null };

// The tool a Cloud session starts another one with; only its results are read, so text a session merely writes or quotes never opens a chat.
const CREATE_SESSION = /(?:^|__)create_session$/;
const SESSION_ID = /^(?:session|cse)_[A-Za-z0-9]{8,64}$/;

// The sessions a Cloud session started whose result is at or after from, in the order its records hold them, each once.
export const childSessionsIn = (
  records: readonly SessionMessage[],
  from = 0,
): CloudChild[] => {
  const calls = new Set<string>();
  const children = new Map<string, CloudChild>();
  for (const [index, record] of records.entries()) {
    for (const block of contentOf(record)) {
      // A call may sit in an earlier record than its result, so calls are gathered from every record.
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

const textsOf = (content: unknown) =>
  typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((item) =>
          isObject(item) && typeof item.text === "string" ? [item.text] : [],
        )
      : [];

const createdIn = (content: unknown): CloudChild | null => {
  for (const text of textsOf(content)) {
    // create_session answers {"ccr":{"id":"session_…","title":…}}, as text.
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

// Whether a Cloud session that ended its turn is still waiting for work it handed off, and so is not done: a session it started and has not archived, or a message it scheduled to itself that has not arrived.
export const waitingIn = (records: readonly SessionMessage[]) => {
  const archived = new Set<string>();
  const cancelled = new Set<string>();
  const calls = new Map<string, Record<string, unknown>>();
  const scheduled: { due: number; trigger: string | null }[] = [];
  const opened: number[] = [];
  for (const record of records) {
    const at = timeOfRecord(record);
    if (record.type === "user" && at !== null && opensTurn(record))
      opened.push(at);
    for (const block of contentOf(record)) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        calls.set(block.id, { ...block, at });
        continue;
      }
      if (
        block.type !== "tool_result" ||
        block.is_error === true ||
        typeof block.tool_use_id !== "string"
      )
        continue;
      const call = calls.get(block.tool_use_id);
      const name = typeof call?.name === "string" ? call.name : "";
      const input = isObject(call?.input) ? call.input : {};
      if (ARCHIVE_SESSION.test(name) && typeof input.session_id === "string")
        archived.add(input.session_id);
      if (DELETE_TRIGGER.test(name) && typeof input.trigger_id === "string")
        cancelled.add(input.trigger_id);
      if (SEND_LATER.test(name))
        scheduled.push({
          due: dueOf(input, typeof call?.at === "number" ? call.at : null),
          trigger:
            TRIGGER_ID.exec(textsOf(block.content).join("\n"))?.[0] ?? null,
        });
    }
  }
  return (
    childSessionsIn(records).some((child) => !archived.has(child.sessionId)) ||
    scheduled.some(
      ({ due, trigger }) =>
        (trigger === null || !cancelled.has(trigger)) &&
        !opened.some((at) => at >= due - FIRE_EARLY_MS),
    )
  );
};

// When a scheduled message is due; one whose time cannot be read counts as due at once, so the next message the session takes ends its wait.
const dueOf = (input: Record<string, unknown>, calledAt: number | null) => {
  const from = calledAt ?? 0;
  if (typeof input.delay_minutes === "number")
    return from + input.delay_minutes * 60_000;
  const at =
    typeof input.at === "string"
      ? Date.parse(input.at.replace(/\[[^\]]*\]$/, ""))
      : Number.NaN;
  return Number.isNaN(at) ? from : at;
};

const timeOfRecord = (record: SessionMessage) => {
  const stamp = (record as { timestamp?: unknown }).timestamp;
  const ms = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
};

// A message that starts a turn of the session, such as one a scheduled message or a session it started delivers, rather than the results of its tools.
const opensTurn = (record: SessionMessage) => {
  const message = isObject(record) ? record.message : null;
  const content = isObject(message) ? message.content : null;
  return (
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.some((block) => isObject(block) && block.type === "text"))
  );
};

const ARCHIVE_SESSION = /(?:^|__)archive_session$/;
const SEND_LATER = /(?:^|__)send_later$/;
const DELETE_TRIGGER = /(?:^|__)delete_trigger$/;
const TRIGGER_ID = /trig_[A-Za-z0-9]+/;
// The scheduler fires by the minute, so a message may come up to a minute before its time.
const FIRE_EARLY_MS = 60_000;
