import { isShapePath } from "../infra/codex/shape.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import type { RecordedShape } from "./feedback-protocol.ts";

export type LogLine = {
  time: string;
  timeMs: number;
  pid: number | null;
  event: string;
  fields: Record<string, unknown>;
};

export type ParsedLog = {
  lines: LogLine[];
  unreadable: number;
  leftOutFields: Set<string>;
};

// Each serializer already copies only known fields; this second pass keeps a report safe from a log an older or newer harnexus wrote, or one edited by hand.
// Only fields named here survive, each value checked against what its serializers write, so free text such as a prompt, a title, a path or an error message never reaches a report.
// A line cut by a writer still appending is the last one, and is not counted as unreadable.
export const parseLog = (text: string): ParsedLog => {
  const leftOutFields = new Set<string>();
  const complete = text.split("\n").slice(0, -1);
  let unreadable = 0;
  const lines: LogLine[] = [];
  for (const row of complete) {
    if (row.trim() === "") continue;
    const line = readLine(row, leftOutFields);
    if (line === null) unreadable += 1;
    else lines.push(line);
  }
  return { lines, unreadable, leftOutFields };
};

const readLine = (row: string, leftOut: Set<string>): LogLine | null => {
  const parsed = parseJson(row);
  if (parsed.isErr() || !isObject(parsed.value)) return null;
  const { time, event, pid, ...rest } = parsed.value;
  if (typeof time !== "string" || !TIME.test(time)) return null;
  if (typeof event !== "string" || !WORD.test(event)) return null;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    const kept = keepField(event, key, value);
    if (kept === LEFT_OUT) {
      if (WORD.test(key)) leftOut.add(key);
    } else {
      fields[key] = kept;
    }
  }
  return {
    time,
    timeMs: Date.parse(time),
    pid: typeof pid === "number" && Number.isSafeInteger(pid) ? pid : null,
    event,
    fields,
  };
};

export type LogSelection = {
  context: string[];
  window: string[];
  omitted: number;
  messages: Map<string, number>;
  shapes: RecordedShape[];
};

// Lines a bridge writes once at start, so one started before the window still shows what it runs and what it found.
const STARTUP_EVENTS = new Set([
  "bridge_started",
  "codex_version",
  "claude_models_loaded",
  "claude_models_unavailable",
  "effort_settings_unavailable",
  "claude_unavailable",
  "call_socket_listening",
  "call_socket_unavailable",
  "log_file_unavailable",
]);

// Steps every healthy turn writes; when the window does not fit, these give way first so failures, refusals and fallbacks stay.
const ROUTINE_STEPS = new Set([
  "started",
  "queued",
  "metrics",
  "record_advanced",
  "effort_applied",
  "own_turn",
  "approval_turn",
  "idle_closed",
  "steered",
  "history_replayed",
  "session_picked",
]);

const isRoutine = (line: LogLine) =>
  line.event === "claude_history_served" ||
  line.event === "claude_history_answered" ||
  (line.event === "claude_turn" &&
    (ROUTINE_STEPS.has(String(line.fields.step)) ||
      (line.fields.step === "finished" && line.fields.status === "completed")));

// Relayed messages, kept only in a log set by hand, are counted by method; shapes, which every log keeps, go to the protocol section.
export const selectLog = (
  lines: readonly LogLine[],
  {
    sinceMs,
    untilMs,
    runningPids,
    budget,
  }: {
    sinceMs: number;
    untilMs: number;
    runningPids: ReadonlySet<number>;
    budget: number;
  },
): LogSelection => {
  const messages = new Map<string, number>();
  const inWindow: LogLine[] = [];
  // Every line in the window names a bridge that was there, a relayed message included, so a bridge that has since ended still gets its startup lines.
  const pids = new Set<number | null>(runningPids);
  for (const line of lines) {
    if (line.timeMs < sinceMs || line.timeMs > untilMs) continue;
    pids.add(line.pid);
    if (line.event === "rpc_shape") continue;
    if (line.event === "rpc_message") {
      const method =
        typeof line.fields.method === "string" ? line.fields.method : "unknown";
      messages.set(method, (messages.get(method) ?? 0) + 1);
    } else {
      inWindow.push(line);
    }
  }
  const latest = new Map<string, LogLine>();
  for (const line of lines) {
    if (line.timeMs >= sinceMs || !STARTUP_EVENTS.has(line.event)) continue;
    if (pids.has(line.pid)) latest.set(`${line.pid}:${line.event}`, line);
  }
  const startup = collapse(
    [...latest.values()].sort((a, b) => a.timeMs - b.timeMs),
  );
  // Many bridges over a long window could fill the report with startup lines alone, so they get a share and the newest are kept.
  const context = keepWithin(startup, Math.floor(budget * CONTEXT_SHARE));
  const rows = collapse(inWindow);
  const kept = keepWithin(rows, Math.max(0, budget - size(context)));
  return {
    context: context.map(({ text }) => text),
    window: kept.map(({ text }) => text),
    omitted: rows.length - kept.length + startup.length - context.length,
    messages,
    shapes: shapesOf(lines, pids, untilMs),
  };
};

// A bridge records a shape when it first meets it, mostly before the window, so every shape a bridge in the window recorded since its last start counts; a pid reused by an earlier bridge brings none of that bridge's shapes.
const shapesOf = (
  lines: readonly LogLine[],
  pids: ReadonlySet<number | null>,
  untilMs: number,
): RecordedShape[] => {
  const byPid = new Map<number | null, RecordedShape[]>();
  for (const line of lines) {
    if (line.timeMs > untilMs || !pids.has(line.pid)) continue;
    if (line.event === "bridge_started") byPid.set(line.pid, []);
    if (line.event !== "rpc_shape") continue;
    const { direction, kind, method, paths } = line.fields;
    if (typeof direction !== "string" || typeof kind !== "string") continue;
    if (!Array.isArray(paths)) continue;
    const shapes = byPid.get(line.pid) ?? [];
    shapes.push({
      direction,
      kind,
      method: typeof method === "string" ? method : null,
      paths: paths.filter(
        (path): path is string => typeof path === "string" && path !== REDACTED,
      ),
    });
    byPid.set(line.pid, shapes);
  }
  return [...byPid.values()].flat();
};

type Row = { line: LogLine; text: string };

const CONTEXT_SHARE = 0.3;

// Repeats of one line from one bridge, such as a refusal on every retry, print once with their count.
const collapse = (lines: readonly LogLine[]): Row[] => {
  const rows: { line: LogLine; key: string; count: number; last: string }[] =
    [];
  for (const line of lines) {
    const key = JSON.stringify([line.pid, line.event, line.fields]);
    const previous = rows.at(-1);
    if (previous?.key === key) {
      previous.count += 1;
      previous.last = line.time;
    } else {
      rows.push({ line, key, count: 1, last: line.time });
    }
  }
  return rows.map(({ line, count, last }) => ({
    line,
    text: `${render(line)}${count > 1 ? ` x${count} until ${last}` : ""}`,
  }));
};

const render = ({ time, pid, event, fields }: LogLine) =>
  JSON.stringify({ time, pid, event, ...fields });

// Notable rows are kept first, then routine ones, each from the newest back, and the kept rows print in their order.
const keepWithin = (rows: readonly Row[], room: number) => {
  const newest = [...rows].reverse();
  const order = [
    ...newest.filter(({ line }) => !isRoutine(line)),
    ...newest.filter(({ line }) => isRoutine(line)),
  ];
  const kept = new Set<Row>();
  let used = 0;
  for (const row of order) {
    const cost = row.text.length + 1;
    if (used + cost > room) continue;
    kept.add(row);
    used += cost;
  }
  return rows.filter((row) => kept.has(row));
};

const size = (rows: readonly Row[]) =>
  rows.reduce((total, { text }) => total + text.length + 1, 0);

export type LoggedStart = {
  pid: number;
  commit: string | null;
  sdk: string | null;
  codex: string | null;
};

// The last start line of each bridge names the commit and SDK it loaded, and the Codex CLI version it met follows it.
export const loggedStarts = (lines: readonly LogLine[]): LoggedStart[] => {
  const starts = new Map<number, LoggedStart>();
  for (const line of lines) {
    if (line.pid === null) continue;
    if (line.event === "bridge_started") {
      starts.set(line.pid, {
        pid: line.pid,
        commit: stringOrNull(line.fields.commit),
        sdk: stringOrNull(line.fields.sdk),
        codex: null,
      });
    } else if (line.event === "codex_version") {
      const start = starts.get(line.pid);
      if (start !== undefined) start.codex = stringOrNull(line.fields.version);
    }
  }
  return [...starts.values()];
};

const stringOrNull = (value: unknown) =>
  typeof value === "string" && value !== REDACTED ? value : null;

const LEFT_OUT = Symbol("left out");

const keepField = (event: string, key: string, value: unknown): unknown => {
  if (key === "settings") return keepSettings(value);
  if (key === "paths" && event === "rpc_shape")
    return Array.isArray(value)
      ? value
          .slice(0, MAX_PATHS)
          .map((item) =>
            typeof item === "string" && isShapePath(item) ? item : REDACTED,
          )
      : scalar(value);
  if (key === "returned")
    return Array.isArray(value)
      ? value.slice(0, MAX_ITEMS).map((item) => checked(SHORT_ID, item))
      : scalar(value);
  const pattern = FIELD_PATTERNS[key];
  return pattern === undefined ? LEFT_OUT : checked(pattern, value);
};

const keepSettings = (value: unknown) => {
  if (!isObject(value)) return scalar(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => SETTING_KEYS.has(key))
      .map(([key, item]) => [key, checked(WORD, item)]),
  );
};

const checked = (pattern: RegExp, value: unknown) =>
  typeof value === "string"
    ? pattern.test(value)
      ? value
      : REDACTED
    : scalar(value);

const scalar = (value: unknown) => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return REDACTED;
};

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// Tags, steps, reasons, statuses and other enum values.
const WORD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const METHOD =
  /^[A-Za-z][A-Za-z0-9_]{0,40}(?:\/[A-Za-z][A-Za-z0-9_]{0,40}){0,5}$/;
const VERSION = /^\d+\.\d+\.\d+[A-Za-z0-9.+-]{0,40}$/;
const MODEL = /^[a-z0-9][a-z0-9.-]{0,63}(?:\[[a-z0-9]{1,8}\])?$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
// A thread's head, or a turn, item or cursor id with harnexus's own ids shortened to their kind and head.
const SHORT_ID = /^(?:anchor )?(?:[hl]:)?[A-Za-z0-9_-]{1,64}$/;
const NUMBER_ONLY = /^$/;
const SHAPE_KEY = /^[0-9a-f]{16}$/;

const FIELD_PATTERNS: Record<string, RegExp> = {
  step: WORD,
  reason: WORD,
  error: WORD,
  status: WORD,
  kind: WORD,
  direction: WORD,
  signal: WORD,
  code: WORD,
  command: WORD,
  reply: WORD,
  effort: WORD,
  method: METHOD,
  version: VERSION,
  bun: VERSION,
  sdk: VERSION,
  claudeCode: VERSION,
  model: MODEL,
  commit: COMMIT,
  shape: SHAPE_KEY,
  thread: SHORT_ID,
  live: SHORT_ID,
  turn: SHORT_ID,
  newest: SHORT_ID,
  cursor: SHORT_ID,
  id: SHORT_ID,
  verified: NUMBER_ONLY,
  compaction: NUMBER_ONLY,
  excludeTurns: NUMBER_ONLY,
  initialPage: NUMBER_ONLY,
  picked: NUMBER_ONLY,
  turns: NUMBER_ONLY,
  count: NUMBER_ONLY,
  inputTokens: NUMBER_ONLY,
  cachedInputTokens: NUMBER_ONLY,
  cacheWriteInputTokens: NUMBER_ONLY,
  outputTokens: NUMBER_ONLY,
  reasoningOutputTokens: NUMBER_ONLY,
  totalTokens: NUMBER_ONLY,
  sessionStartMs: NUMBER_ONLY,
  firstMessageMs: NUMBER_ONLY,
  turnMs: NUMBER_ONLY,
};

const SETTING_KEYS = new Set([
  "permissionMode",
  "unverifiedCodex",
  "statePath",
  "logPath",
  "callSocket",
]);

const REDACTED = "<redacted>";
const MAX_ITEMS = 64;
const MAX_PATHS = 400;
