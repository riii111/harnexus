import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import { isObject } from "../../../../lib/object.ts";
import { endsTurn, turnOpeningTextOf } from "../../history/history.view.ts";
import { INTERRUPTED } from "../../history/message.view.ts";
import { waitingIn } from "./children.ts";
import { contentOf, textsOf } from "./records.ts";

// What a Cloud session is doing, as far as its copied records tell.
export type CloudSessionState =
  | { kind: "starting" }
  | { kind: "working" }
  | {
      kind: "awaiting_input";
      ask: "question" | "plan";
      toolUseId: string;
      input: Record<string, unknown>;
    }
  | { kind: "resumes_later" }
  | { kind: "replied" }
  | { kind: "interrupted" }
  | { kind: "errored" };

// The state of a session from its main records, judged by how they end: an error or interruption at the end outweighs an older question, and a question outweighs work a reply left scheduled.
//
//                ┌────────────── next prompt, answer or scheduled wake-up ───────────────┐
//                ▼                                                                       │
//   starting ─> working ─┬─ asks a question or plan ─> *awaiting_input ──────────────────┤
//                        ├─ ends its turn ───────────> *replied ─────────────────────────┤
//                        ├─ stopped on claude.ai ────> *interrupted ─────────────────────┤
//                        ├─ API error ───────────────> *errored ─────────────────────────┤
//                        └─ ends with work scheduled ─> *resumes_later ──────────────────┘
//
//   * ends the chat's turn there, as claude.ai shows the turn over; a session that resumes by itself is shown in a turn of its own.
export const sessionStateOf = (
  records: readonly SessionMessage[],
): CloudSessionState => {
  // Claude Code's own notices, such as a worker restart, are meta records the SDK never hands over, so the last record is the session's own.
  const last = records.at(-1);
  if (last === undefined) return { kind: "starting" };
  if (isSynthetic(last) && !endsTurn(last)) {
    return { kind: "errored" };
  }

  if (isInterruption(last)) return { kind: "interrupted" };
  const asked = pendingAsk(records);
  if (asked !== null) return asked;
  if (replied(last)) {
    return waitingIn(records) ? { kind: "resumes_later" } : { kind: "replied" };
  }

  return { kind: "working" };
};

// What a chat was left at in this state, so the same question or stop is shown once and a new one again: the question asked, or else the session's last record.
export const stateKeyOf = (
  records: readonly SessionMessage[],
  state: CloudSessionState,
) =>
  state.kind === "awaiting_input"
    ? state.toolUseId
    : (records.at(-1)?.uuid ?? null);

// The tool the session's last record called, which tells what it was doing when it went quiet.
export const runningToolOf = (records: readonly SessionMessage[]) => {
  const last = records.at(-1);
  if (last === undefined || last.type !== "assistant") return null;
  const call = contentOf(last).find((block) => block.type === "tool_use");
  return typeof call?.name === "string" ? call.name : null;
};

// Whether the session ended its turn, so a chat following it stops waiting, even when the session will go on by itself later.
export const handsBack = (state: CloudSessionState) =>
  state.kind === "replied" ||
  state.kind === "resumes_later" ||
  state.kind === "awaiting_input" ||
  state.kind === "interrupted" ||
  state.kind === "errored";

// Matches records of one copy against a message sent from the app: a prompt with its text, or the answer it gave a question or plan the session was waiting on.
export const sentMatcherOf = (records: readonly SessionMessage[]) => {
  // The questions and plans are collected from this copy once, and only when a tool result asks for them.
  let asks: ReadonlySet<string> | null = null;
  const askIds = () => (asks ??= askIdsIn(records));
  return (message: SessionMessage, text: string) =>
    turnOpeningTextOf(message)?.trim() === text.trim() ||
    answersAsk(message, text, askIds);
};

// A record that ends Claude's turn with something to read; a copy may mark the thinking that opens the reply as the end too, before the reply's text arrives.
const replied = (message: SessionMessage) =>
  endsTurn(message) &&
  contentOf(message).some(
    (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
  );

// The question or plan the current turn asked that no result has answered yet; a new prompt or an interruption leaves an earlier one behind.
const pendingAsk = (
  records: readonly SessionMessage[],
): CloudSessionState | null => {
  const pending = new Map<
    string,
    { ask: "question" | "plan"; input: Record<string, unknown> }
  >();
  for (const record of records) {
    if (turnOpeningTextOf(record) !== null || isInterruption(record)) {
      pending.clear();
      continue;
    }

    for (const block of contentOf(record)) {
      const ask = askOf(block);
      if (ask !== null && typeof block.id === "string") {
        pending.set(block.id, {
          ask,
          input: isObject(block.input) ? block.input : {},
        });
      }

      if (block.type === "tool_result" && typeof block.tool_use_id === "string")
        pending.delete(block.tool_use_id);
    }
  }

  const found = [...pending].at(-1);
  return found === undefined
    ? null
    : { kind: "awaiting_input", toolUseId: found[0], ...found[1] };
};

const answersAsk = (
  message: SessionMessage,
  text: string,
  askIds: () => ReadonlySet<string>,
) => {
  if (message.type !== "user") return false;
  // Claude Code writes answers as "question"="answer" pairs ending in a comma or period, so the text counts only whole and in the answer's place, never as a question or part of a longer answer.
  const wanted = `="${text.trim()}"`;
  return contentOf(message).some(
    (block) =>
      block.type === "tool_result" &&
      typeof block.tool_use_id === "string" &&
      askIds().has(block.tool_use_id) &&
      textsOf(block.content).some((answer) => holdsAnswer(answer, wanted)),
  );
};

const holdsAnswer = (result: string, wanted: string) => {
  for (
    let at = result.indexOf(wanted);
    at !== -1;
    at = result.indexOf(wanted, at + 1)
  ) {
    const next = result[at + wanted.length];
    if (next === undefined || next === "," || next === ".") return true;
  }

  return false;
};

const askIdsIn = (records: readonly SessionMessage[]) => {
  const ids = new Set<string>();
  for (const record of records) {
    for (const block of contentOf(record)) {
      if (askOf(block) !== null && typeof block.id === "string")
        ids.add(block.id);
    }
  }

  return ids;
};

const askOf = (block: Record<string, unknown>) => {
  if (block.type !== "tool_use") return null;
  if (block.name === ASK_USER_QUESTION) return "question" as const;
  return block.name === EXIT_PLAN_MODE ? ("plan" as const) : null;
};

// Claude Code writes what it says itself, such as an API error, as a reply from no model; the SDK drops the record's own error flag.
const isSynthetic = (message: SessionMessage) =>
  message.type === "assistant" &&
  isObject(message.message) &&
  message.message.model === SYNTHETIC_MODEL;

const isInterruption = (message: SessionMessage) =>
  message.type === "user" &&
  textsOf(isObject(message.message) ? message.message.content : null).some(
    (text) => INTERRUPTED.test(text),
  );

const ASK_USER_QUESTION = "AskUserQuestion";
const EXIT_PLAN_MODE = "ExitPlanMode";
const SYNTHETIC_MODEL = "<synthetic>";
