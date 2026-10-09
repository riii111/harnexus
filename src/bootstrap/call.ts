import type { CallOutcome } from "../infra/codex/call-gateway.ts";
import { loadCallerSocketPath } from "../runtime/config.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import { requestLine } from "../runtime/socket.boundary.ts";

const EXIT = {
  done: 0,
  tool_error: 1,
  not_sent: 2,
  unknown: 3,
  rejected: 4,
  invalid: 5,
  // The thread exists but never ran, so creating another is a choice, not a retry.
  model_mismatch: 6,
  first_turn_refused: 7,
} as const satisfies Record<CallOutcome, number>;

// Longer than the longest wait_threads the bridge allows, so the bridge always answers first.
const ANSWER_TIMEOUT_MS = 15 * 60_000;

// The exit status tells a call that never left (2, safe to send again) from one whose effect is unknown (3, never send again).
const path = loadCallerSocketPath(process.env).unwrapOr(null);
if (path === null) {
  process.stderr.write("harnexus call: HARNEXUS_STATE_PATH is invalid\n");
  process.exit(EXIT.invalid);
}
const line = (await Bun.stdin.text()).trim().replaceAll("\n", " ");
const answer = await requestLine(path, line, ANSWER_TIMEOUT_MS);
if (answer.isErr()) {
  // A socket that could not be connected to never received the call; any other failure came after it was written.
  const unreached = !answer.error.connected;
  process.stderr.write(
    `harnexus call: ${answer.error.message} (${answer.error.code ?? "no code"})\n`,
  );
  process.exit(unreached ? EXIT.not_sent : EXIT.unknown);
}
process.stdout.write(`${answer.value}\n`);
const parsed = parseJson(answer.value);
const outcome =
  parsed.isOk() && isObject(parsed.value) ? parsed.value.outcome : undefined;
process.exit(
  typeof outcome === "string" && outcome in EXIT
    ? EXIT[outcome as keyof typeof EXIT]
    : EXIT.unknown,
);
