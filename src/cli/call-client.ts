import type { CallOutcome } from "../features/link/call-gateway.ts";
import { loadCallerSocket } from "../lib/config.ts";
import { parseJson } from "../lib/json.boundary.ts";
import { isObject } from "../lib/object.ts";
import { requestLine } from "../lib/socket.boundary.ts";

// A bridge that does not answer the version query, such as one from before it, is told apart from every outcome a call can have, since nothing was sent to it.
// chat_not_opened is cloud_open's own: the session it started runs on, so the prompt is not to be sent again.
export type ClientOutcome = CallOutcome | "unsupported" | "chat_not_opened";

export type ClientAnswer = {
  outcome: ClientOutcome;
  message?: string;
  [key: string]: unknown;
};

export const EXIT = {
  done: 0,
  tool_error: 1,
  not_sent: 2,
  unknown: 3,
  rejected: 4,
  invalid: 5,
  // The thread exists but never ran, so creating another is a choice, not a retry.
  model_mismatch: 6,
  first_turn_refused: 7,
  unsupported: 8,
  chat_not_opened: 9,
} as const satisfies Record<ClientOutcome, number>;

export const exitOf = (outcome: unknown) =>
  typeof outcome === "string" && Object.hasOwn(EXIT, outcome)
    ? EXIT[outcome as ClientOutcome]
    : EXIT.unknown;

const PROTOCOL_VERSION = 1;

// Longer than the longest wait_threads the bridge allows, so the bridge always answers first.
const ANSWER_TIMEOUT_MS = 15 * 60_000;
const QUERY_TIMEOUT_MS = 10_000;

// Asks the bridge for protocol 1 and sends the call only once the bridge has said it offers the tool, so an older bridge never receives it.
export const callV1 = async (
  env: Record<string, string | undefined>,
  call: { threadId: string; tool: string; arguments: Record<string, unknown> },
): Promise<ClientAnswer> => {
  const socket = loadCallerSocket(env);
  if (socket.isErr())
    return { outcome: "invalid", message: socket.error.message };
  if (socket.value === null)
    return {
      outcome: "not_sent",
      message: "the call socket is off (HARNEXUS_CALL_SOCKET=off)",
    };
  const path = socket.value;
  const query = await requestLine(
    path,
    JSON.stringify({ version: PROTOCOL_VERSION, query: "capabilities" }),
    QUERY_TIMEOUT_MS,
  );
  // The query changes nothing, so any failure of it leaves the call unsent.
  if (query.isErr())
    return {
      outcome: "not_sent",
      message: `${path}: ${query.error.code ?? query.error.message}`,
    };
  const offered = parseJson(query.value).unwrapOr(null);
  if (
    !isObject(offered) ||
    offered.outcome !== "done" ||
    offered.version !== PROTOCOL_VERSION ||
    !Array.isArray(offered.operations)
  )
    return {
      outcome: "unsupported",
      message: `the bridge does not offer call protocol ${PROTOCOL_VERSION}; update harnexus and restart the app`,
    };
  if (!offered.operations.includes(call.tool))
    return {
      outcome: "unsupported",
      message: `the bridge does not offer ${call.tool}`,
    };

  const answer = await requestLine(
    path,
    JSON.stringify({ version: PROTOCOL_VERSION, ...call }),
    ANSWER_TIMEOUT_MS,
  );
  // A socket that could not be connected to never received the call; any other failure came after it was written.
  if (answer.isErr())
    return {
      outcome: answer.error.connected ? "unknown" : "not_sent",
      message: `${answer.error.message} (${answer.error.code ?? "no code"})`,
    };
  const parsed = parseJson(answer.value).unwrapOr(null);
  return isObject(parsed) && typeof parsed.outcome === "string"
    ? (parsed as ClientAnswer)
    : { outcome: "unknown", message: "the bridge answered without an outcome" };
};
