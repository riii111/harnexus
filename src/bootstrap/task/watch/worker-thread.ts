import { join } from "node:path";
import { isDirectory } from "../../../runtime/fs.boundary.ts";
import { parseJson } from "../../../runtime/json.boundary.ts";
import { isObject } from "../../../runtime/object.ts";
import type { Fields } from "../format.ts";
import type { Env } from "../request.ts";
import { load, namesIn, stateRoot } from "../session.ts";

export type AppCall = (
  caller: string,
  tool: string,
  args: Fields,
) => Promise<Fields>;

export type ThreadView =
  | { gone: true }
  | { gone: false; active: boolean; turns: Turn[] };

export type Turn = {
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  origin: "owner" | "delegated" | "other";
  answer: string;
};

// The worker's reviewer is a Codex thread that already messages the worker, and a thread cannot message itself.
export const senderOf = async (env: Env, worker: string) => {
  const root = join(stateRoot(env), "review");
  const keys = await namesIn(root);
  for (const key of keys.isOk() ? keys.value.sort() : []) {
    if (!(await isDirectory(join(root, key)))) continue;

    const loaded = await load(join(root, key, "state.json"));
    const state = loaded.isOk() ? loaded.value : null;
    if (
      isObject(state) &&
      typeof state.reviewer === "string" &&
      isObject(state.candidate) &&
      state.candidate.workerChatId === worker
    )
      return state.reviewer;
  }
  return null;
};

// Null means the app could not be asked, as while it is closed or the Mac sleeps; the next cycle asks again.
export const readThread = async (
  callApp: AppCall,
  caller: string,
  thread: string,
): Promise<ThreadView | null> => {
  const answer = await callApp(caller, "read_thread", {
    threadId: thread,
    turnLimit: 5,
    includeOutputs: false,
  });
  const text = resultText(answer);
  if (answer.outcome === "tool_error" && text.includes(NO_THREAD))
    return { gone: true };
  if (answer.outcome !== "done") return null;

  const parsed = parseJson(text);
  const read = parsed.isOk() && isObject(parsed.value) ? parsed.value : null;
  if (read === null || !isObject(read.thread)) return null;

  const status = isObject(read.thread.status) ? read.thread.status.type : null;
  const turns = (Array.isArray(read.turns) ? read.turns : [])
    .filter(isObject)
    .map(turnOf);
  return { gone: false, active: status === "active", turns };
};

// What the app answers for a thread that was deleted or never existed.
const NO_THREAD = "No Codex thread found";

const resultText = (answer: Fields) => {
  const result = answer.result;
  if (!isObject(result) || !Array.isArray(result.content)) return "";

  return result.content
    .flatMap((item) =>
      isObject(item) && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n");
};

const turnOf = (turn: Record<string, unknown>): Turn => {
  const items = Array.isArray(turn.items) ? turn.items : [];
  return {
    status: String(turn.status ?? ""),
    startedAt: numberOrNull(turn.startedAt),
    completedAt: numberOrNull(turn.completedAt),
    origin: originOf(items),
    answer: answerOf(items),
  };
};

// A Claude thread shows a message from another thread as a user message carrying the delegation, and a Codex thread as the output of the call that sent it.
const originOf = (items: unknown[]): Turn["origin"] => {
  const first = items[0];
  if (!isObject(first)) return "other";
  if (first.type === "functionCallOutput")
    return DELEGATING.has(String(first.name)) ? "delegated" : "other";
  if (first.type !== "userMessage") return "other";
  if (isObject(first.codexDelegation)) return "delegated";

  const content = Array.isArray(first.content) ? first.content : [];
  const delegated = content.some(
    (part) =>
      isObject(part) &&
      typeof part.text === "string" &&
      part.text.trimStart().startsWith("<codex_delegation>"),
  );
  return delegated ? "delegated" : "owner";
};

const DELEGATING = new Set(["send_message_to_thread", "create_thread"]);

const answerOf = (items: unknown[]) => {
  const messages = items.filter(
    (item): item is Record<string, unknown> =>
      isObject(item) && item.type === "agentMessage",
  );
  const finals = messages.filter((item) => item.phase === "final_answer");
  const chosen = finals.length > 0 ? finals : messages.slice(-1);
  return chosen.map((item) => String(item.text ?? "")).join("\n");
};

const numberOrNull = (value: unknown) =>
  typeof value === "number" ? value : null;

export const busyReason = (
  view: { active: boolean; turns: Turn[] },
  now: Date,
) => {
  const latest = view.turns[0];
  if (view.active || latest?.status === "inProgress")
    return "worker turn in progress";
  if (
    latest?.origin === "owner" &&
    latest.completedAt !== null &&
    now.getTime() - latest.completedAt * 1000 < OWNER_GRACE_MS
  )
    return "owner just talked to the worker";
  return null;
};

// A worker the owner just talked to may still be in that conversation, so a message waits this long after the owner's turn.
const OWNER_GRACE_MS = 5 * 60_000;

// The first turn a message from another thread started after ours was sent; the read lists turns newest first.
export const answerTo = (turns: readonly Turn[], sentAt: string) => {
  const after = Date.parse(sentAt) / 1000 - CLOCK_SKEW_SECONDS;
  return turns
    .filter(
      (turn) =>
        turn.origin === "delegated" &&
        turn.startedAt !== null &&
        turn.startedAt >= after,
    )
    .at(-1);
};

// The app stamps turns in whole seconds.
const CLOCK_SKEW_SECONDS = 5;
