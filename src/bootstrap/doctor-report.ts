import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";

export type Check = {
  status: "ok" | "warn" | "fail";
  name: string;
  detail: string;
};

export type ProcessEntry = { pid: number; ppid: number; command: string };

// Lines are what ps prints for "pid=,ppid=,command=", one process each.
export const parseProcesses = (output: string): ProcessEntry[] =>
  output.split("\n").flatMap((line) => {
    const matched = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return matched === null
      ? []
      : [
          {
            pid: Number(matched[1]),
            ppid: Number(matched[2]),
            command: matched[3] ?? "",
          },
        ];
  });

// A bridge whose app-server is gone is left under launchd (ppid 1), and so is a Claude process whose bridge is gone; only pids are shown, since a command line can carry a prompt.
// Only processes run from this checkout count, so another project's server or another tool's Claude is never offered for kill.
export const processChecks = (
  processes: readonly ProcessEntry[],
  repo: string,
): Check[] => {
  const bridge = `${repo}/src/bootstrap/main.ts`;
  const claude = `${repo}/node_modules/@anthropic-ai/claude-agent-sdk-`;
  const bridges = processes.filter(({ command }) => runs(command, bridge));
  const bridgePids = new Set(bridges.map(({ pid }) => pid));
  const claudes = processes.filter(
    ({ command }) => command.includes(claude) && CLAUDE_BINARY.test(command),
  );
  const leftBridges = bridges.filter(({ ppid }) => ppid === LAUNCHD);
  const leftClaudes = claudes.filter(({ ppid }) => ppid === LAUNCHD);
  const owned = claudes.filter(({ ppid }) => bridgePids.has(ppid));
  return [
    {
      status: leftBridges.length === 0 ? "ok" : "warn",
      name: "Bridges",
      detail:
        leftBridges.length === 0
          ? `${bridges.length} running`
          : `${bridges.length} running, ${leftBridges.length} left without an app-server; stop them with kill ${pids(leftBridges)}`,
    },
    {
      status: leftClaudes.length === 0 ? "ok" : "warn",
      name: "Claude processes",
      detail:
        leftClaudes.length === 0
          ? `${owned.length} run by a bridge`
          : `${owned.length} run by a bridge, ${leftClaudes.length} left without one; stop them with kill ${pids(leftClaudes)}`,
    },
  ];
};

// Only event names, methods, reasons and versions are read, so a pasted report carries no more than the log's own fields allow.
export const logChecks = (text: string, path: string, now: number): Check[] => {
  const recent = text.split("\n").flatMap((line): LogEntry[] => {
    const parsed = parseJson(line);
    if (parsed.isErr() || !isObject(parsed.value)) return [];
    const time = parsed.value.time;
    return typeof time === "string" && Date.parse(time) >= now - LOG_WINDOW_MS
      ? [{ ...parsed.value, time }]
      : [];
  });
  const of = (event: string) => recent.filter((entry) => entry.event === event);
  const version = of("codex_version").at(-1);
  const unavailable = tally(
    of("call_socket_unavailable").map((entry) => field(entry.reason)),
  );
  const refusals = [
    ...of("claude_request_refused").map((entry) => ({
      key: `request ${field(entry.method)} ${field(entry.reason)}`,
      time: entry.time,
    })),
    ...of("claude_turn")
      .filter((entry) => entry.step === "refused")
      .map((entry) => ({
        key: `turn ${field(entry.reason)}`,
        time: entry.time,
      })),
  ];
  const last = new Map(refusals.map(({ key, time }) => [key, time]));
  const refused = [...tally(refusals.map(({ key }) => key))].map(
    ([key, count]) => `${key} ${count} (last ${last.get(key)})`,
  );
  return [
    {
      status: of("standard_fallback").length > 0 ? "warn" : "ok",
      name: "Standard fallback",
      detail:
        of("standard_fallback").length > 0
          ? `${of("standard_fallback").length} in the last 24h; standard Codex used because the bridge was unavailable or unverified`
          : "none in the last 24h",
    },
    {
      status: "ok",
      name: "Log",
      detail: `${of("bridge_started").length} bridge starts in the last 24 hours, Codex CLI ${cliVersion(version)}, in ${path}`,
    },
    {
      status: unavailable.size === 0 ? "ok" : "warn",
      name: "Call socket",
      detail: [
        `listening ${of("call_socket_listening").length}`,
        ...[...unavailable].map(
          ([reason, count]) => `unavailable ${count} (${reason})`,
        ),
      ].join(", "),
    },
    {
      status: refused.length === 0 ? "ok" : "warn",
      name: "Refusals",
      detail: refused.length === 0 ? "none" : refused.join("; "),
    },
  ];
};

// A sandbox refuses with EPERM where file modes refuse with EACCES, so EPERM says only that this shell may not look, not what the app can do.
export const refusedCheck = (
  name: string,
  detail: string,
  cause: unknown,
): Check => {
  const code = isObject(cause) ? cause.code : undefined;
  if (code === "EPERM")
    return {
      status: "warn",
      name,
      detail: `${detail}: not permitted to this shell (EPERM), as in a sandbox; run this outside the sandbox to check`,
    };
  return {
    status: "fail",
    name,
    detail:
      code === "EACCES" ? `${detail}: permission denied (EACCES)` : detail,
  };
};

export const fallbackCheck = (record: unknown): Check => {
  if (record === null)
    return {
      status: "ok",
      name: "Last standard fallback",
      detail: "none recorded",
    };
  if (
    !isObject(record) ||
    typeof record.time !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T[\d:]+Z$/.test(record.time) ||
    typeof record.reason !== "string" ||
    ![
      "UnverifiedCodex",
      "BunUnavailable",
      "BridgeStartupTimeout",
      "BridgeStartupFailed",
    ].includes(record.reason)
  )
    return {
      status: "warn",
      name: "Last standard fallback",
      detail: "invalid failure record",
    };
  const version =
    typeof record.version === "string" &&
    /^\d+\.\d+\.\d+[a-zA-Z0-9.+-]{0,60}$/.test(record.version)
      ? record.version
      : "unknown";
  return {
    status: "warn",
    name: "Last standard fallback",
    detail: `${record.time}: ${record.reason}; Codex CLI ${version}; run bun run open-app after repairing the setup`,
  };
};

export const formatReport = (checks: readonly Check[]) =>
  `${checks
    .map(
      ({ status, name, detail }) =>
        `${status.padEnd(STATUS_WIDTH)}${name}: ${detail}`,
    )
    .join("\n")}\n`;

export const failed = (checks: readonly Check[]) =>
  checks.some(({ status }) => status === "fail");

const pids = (entries: readonly ProcessEntry[]) =>
  entries.map(({ pid }) => pid).join(" ");

// The path must be a whole word of the command, so a checkout nested under another path does not match.
const runs = (command: string, path: string) =>
  ` ${command} `.includes(` ${path} `);

// The SDK starts the Claude Code binary it ships in its platform package.
const CLAUDE_BINARY = /claude-agent-sdk-[a-z0-9-]+\/claude(\s|$)/;

type LogEntry = Record<string, unknown> & { time: string };

const tally = (keys: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
};

const field = (value: unknown) =>
  typeof value === "string" ? value : "unknown";

const cliVersion = (entry: LogEntry | undefined) => {
  if (entry === undefined) return "not seen";
  const version = field(entry.version);
  return entry.verified === false ? `${version} (unchecked)` : version;
};

const LOG_WINDOW_MS = 24 * 60 * 60 * 1000;

const LAUNCHD = 1;

const STATUS_WIDTH = 5;
