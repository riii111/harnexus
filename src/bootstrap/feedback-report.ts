import { Result, TaggedError } from "better-result";
import type { BridgeSettings } from "./bridge-identity.ts";
import type { CheckoutHead } from "./checkout.ts";
import { type Check, formatReport } from "./doctor-report.ts";
import type { LoggedStart, LogSelection } from "./feedback-log.ts";

class TimeArgumentInvalid extends TaggedError("TimeArgumentInvalid")<{
  message: string;
}> {}

// A duration counts back from now, so a user can cover a problem without converting its time to UTC; an ISO time without an offset is local.
export const parseTimeArgument = (
  name: "--since" | "--until",
  arg: string | undefined,
  now: number,
  fallbackMs: number,
) => {
  if (arg === undefined) return Result.ok(fallbackMs);
  const duration = /^(\d+)([mhd])$/.exec(arg);
  if (duration !== null) {
    const ms =
      Number(duration[1]) * UNIT_MS[duration[2] as keyof typeof UNIT_MS];
    if (ms <= MAX_WINDOW_MS) return Result.ok(now - ms);
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(arg)) {
    const time = Date.parse(arg);
    if (!Number.isNaN(time) && time <= now && now - time <= MAX_WINDOW_MS)
      return Result.ok(time);
  }
  return Result.err(
    new TimeArgumentInvalid({
      message: `${name} must be a duration such as 30m, 2h or 3d, or a time such as 2026-10-24T18:30 or 2026-10-24T18:30+09:00, within the last 7 days`,
    }),
  );
};

export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const MAX_WINDOW_MS = 7 * UNIT_MS.d;

export type TimedProcess = {
  pid: number;
  ppid: number;
  elapsedMs: number | null;
  command: string;
};

// Lines are what ps prints for "pid=,ppid=,etime=,command=", one process each.
export const parseTimedProcesses = (output: string): TimedProcess[] =>
  output.split("\n").flatMap((line) => {
    const matched = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return matched === null
      ? []
      : [
          {
            pid: Number(matched[1]),
            ppid: Number(matched[2]),
            elapsedMs: parseElapsed(matched[3] ?? ""),
            command: matched[4] ?? "",
          },
        ];
  });

// ps prints a process's elapsed time as [[dd-]hh:]mm:ss whatever the locale, unlike its start time.
export const parseElapsed = (etime: string) => {
  const matched = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (matched === null) return null;
  const [days = 0, hours = 0, minutes = 0, seconds = 0] = matched
    .slice(1)
    .map((part) => (part === undefined ? 0 : Number(part)));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
};

export type RunningBridge = { pid: number; startedAtMs: number | null };

// Only pids and start times are kept, since a command line can carry a prompt.
// Another checkout's bridge runs main.ts with --launcher too, so it is counted, which tells a report run from the wrong checkout.
export const findBridges = (
  processes: readonly TimedProcess[],
  repo: string,
  now: number,
) => {
  const own = ` ${repo}/src/bootstrap/main.ts --launcher `;
  const bridges = processes.filter(({ command }) =>
    ANY_BRIDGE.test(` ${command} `),
  );
  const mine = bridges.filter(({ command }) => ` ${command} `.includes(own));
  return {
    mine: mine.map(({ pid, elapsedMs }) => ({
      pid,
      startedAtMs: elapsedMs === null ? null : now - elapsedMs,
    })),
    others: bridges.length - mine.length,
  };
};

const ANY_BRIDGE = /\/src\/bootstrap\/main\.ts --launcher\s/;

// The app's main process keeps the Codex CLI and environment it started with until it quits.
export const appStartedAt = (
  processes: readonly TimedProcess[],
  app: string,
  now: number,
) => {
  const main = `${app}/Contents/MacOS/`;
  const elapsed = processes
    .filter(({ command }) => command.startsWith(main))
    .map(({ elapsedMs }) => elapsedMs)
    .filter((ms): ms is number => ms !== null);
  return elapsed.length === 0 ? null : now - Math.max(...elapsed);
};

export type GitChanges = {
  code: readonly string[];
  otherTracked: number;
  untracked: number;
};

// git status --porcelain=v1 -z names each change once, with a rename or copy followed by its source path.
export const classifyChanges = (porcelain: string): GitChanges => {
  const code: string[] = [];
  let otherTracked = 0;
  let untracked = 0;
  const entries = porcelain.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    const state = entry.slice(0, 2);
    const path = entry.slice(3);
    if (state.includes("R") || state.includes("C")) index += 1;
    if (state === "??") untracked += 1;
    else if (isCode(path)) code.push(path);
    else otherTracked += 1;
  }
  return { code: code.slice(0, MAX_LISTED_CHANGES), otherTracked, untracked };
};

// Only harnexus's own code is named; any other path is the user's and only counted.
const isCode = (path: string) =>
  CODE_FILES.has(path) ||
  CODE_DIRECTORIES.some((directory) => path.startsWith(directory));

const CODE_FILES = new Set([
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "biome.json",
]);
const CODE_DIRECTORIES = ["src/", "bin/", "test/", "biome-plugins/"];
const MAX_LISTED_CHANGES = 20;

export type DependencyState = {
  name: string;
  pinned: string;
  installed: string | null;
};

export type LogFacts =
  | { state: "off" }
  | { state: "unreadable"; reason: string }
  | {
      state: "read";
      path: string;
      oldestMs: number | null;
      complete: boolean;
      unreadable: number;
      leftOutFields: readonly string[];
      selection: LogSelection;
    };

export type FeedbackFacts = {
  nowMs: number;
  offsetMinutes: number;
  sinceMs: number;
  untilMs: number;
  platform: { macos: string | null; arch: string };
  head: CheckoutHead | null;
  current: { sdk: string | null; claudeCode: string | null };
  changes: GitChanges | null;
  dependencies: readonly DependencyState[];
  // The newest time of the code, packages and launcher a bridge loads at start, tests left out.
  codeChangedAtMs: number | null;
  bridges: { mine: readonly RunningBridge[]; others: number };
  loggedStarts: readonly LoggedStart[];
  setup: {
    launchd: "registered" | "none" | "unreadable";
    otherCheckout: boolean;
    settings: BridgeSettings;
    bun: { path: string; version: string | null } | null;
    pinnedBun: string | null;
  };
  app: {
    startedAtMs: number | null;
    installedCodex: string | null;
    runningCodex: readonly string[];
  };
  doctor: readonly Check[];
  log: LogFacts;
};

export const formatFeedback = (facts: FeedbackFacts) =>
  [
    "harnexus feedback report",
    `Generated ${iso(facts.nowMs)}; local time is UTC${offset(facts.offsetMinutes)}`,
    `Window ${iso(facts.sinceMs)} to ${iso(facts.untilMs)} (local ${local(facts.sinceMs, facts.offsetMinutes)} to ${local(facts.untilMs, facts.offsetMinutes)})`,
    "",
    "== harnexus ==",
    formatReport(checkoutChecks(facts)).trimEnd(),
    "",
    "== App setup ==",
    formatReport(setupChecks(facts)).trimEnd(),
    "",
    "== doctor ==",
    formatReport(facts.doctor).trimEnd(),
    "",
    "== Log ==",
    ...logSection(facts),
    "",
  ].join("\n");

const checkoutChecks = (facts: FeedbackFacts): Check[] => [
  commitCheck(facts.head),
  changesCheck(facts.changes),
  dependenciesCheck(facts.dependencies, facts.current),
  ...bridgeChecks(facts),
];

const commitCheck = (head: CheckoutHead | null): Check => {
  if (head === null)
    return {
      status: "warn",
      name: "Commit",
      detail: "not a git checkout; the code version is unknown",
    };
  const branch =
    head.branch === null
      ? "detached HEAD"
      : PUBLIC_BRANCHES.has(head.branch)
        ? head.branch
        : "a local branch";
  return {
    status: head.commit === null ? "warn" : "ok",
    name: "Commit",
    detail: `${head.commit ?? "unknown"} on ${branch}${head.movedAtMs === null ? "" : `, checked out ${iso(head.movedAtMs)}`}`,
  };
};

// A branch name is the user's own text unless it is one harnexus publishes.
const PUBLIC_BRANCHES = new Set(["main"]);

const changesCheck = (changes: GitChanges | null): Check => {
  if (changes === null)
    return {
      status: "warn",
      name: "Local changes",
      detail: "unknown; git status did not run",
    };
  const parts = [
    changes.code.length > 0 ? `changed ${changes.code.join(", ")}` : null,
    changes.otherTracked > 0
      ? `${changes.otherTracked} other tracked files changed`
      : null,
    changes.untracked > 0 ? `${changes.untracked} untracked files` : null,
  ].filter((part) => part !== null);
  return {
    status: changes.code.length > 0 ? "warn" : "ok",
    name: "Local changes",
    detail: parts.length === 0 ? "none" : parts.join("; "),
  };
};

const dependenciesCheck = (
  dependencies: readonly DependencyState[],
  current: FeedbackFacts["current"],
): Check => {
  const differing = dependencies.filter(
    ({ pinned, installed }) => installed !== pinned,
  );
  return differing.length === 0
    ? {
        status: "ok",
        name: "Dependencies",
        detail: `installed as pinned; the SDK bundles Claude Code ${current.claudeCode ?? "of an unknown version"}`,
      }
    : {
        status: "fail",
        name: "Dependencies",
        detail: `${differing
          .map(
            ({ name, pinned, installed }) =>
              `${name} ${installed ?? "missing"} (pinned ${pinned})`,
          )
          .join(
            ", ",
          )}; run bun install, then quit the app and reopen it with bun run open-app`,
      };
};

// A bridge keeps the code it loaded, so one started before a pull, an edit or bun install runs older code than this checkout, as does one whose start line names another commit or SDK.
const bridgeChecks = (facts: FeedbackFacts): Check[] => {
  const { mine, others } = facts.bridges;
  const started = new Map(
    facts.loggedStarts.map((start) => [start.pid, start]),
  );
  // The commit and SDK a bridge logged at start are compared first; file times also catch an edit or install not committed, and HEAD's move stands in for the commit of a bridge that logged none.
  const isStale = ({ pid, startedAtMs }: RunningBridge) => {
    const logged = started.get(pid);
    const current = facts.head?.commit ?? null;
    if (
      logged !== undefined &&
      ((logged.commit !== null &&
        current !== null &&
        !current.startsWith(logged.commit)) ||
        logged.sdk !== facts.current.sdk)
    )
      return true;
    const changed = [
      facts.codeChangedAtMs,
      logged === undefined ? (facts.head?.movedAtMs ?? null) : null,
    ];
    return (
      startedAtMs !== null &&
      changed.some((time) => time !== null && startedAtMs < time)
    );
  };
  const stale = mine.filter(isStale);
  const listed = mine.map(({ pid, startedAtMs }) => {
    const commit = started.get(pid)?.commit;
    return `pid ${pid} since ${startedAtMs === null ? "unknown" : iso(startedAtMs)}${commit == null ? "" : ` on ${commit}`}`;
  });
  const checks: Check[] = [
    {
      status: stale.length === 0 ? "ok" : "warn",
      name: "Running bridges",
      detail:
        mine.length === 0
          ? "none from this checkout"
          : `${listed.join(", ")}${stale.length === 0 ? "" : `; ${stale.length} run code older than this checkout, so quit the app and reopen it with bun run open-app`}`,
    },
  ];
  if (others > 0)
    checks.push({
      status: "warn",
      name: "Other bridges",
      detail: `${others} running from another harnexus checkout; run bun run feedback in the checkout the app uses`,
    });
  return checks;
};

const setupChecks = (facts: FeedbackFacts): Check[] => {
  const { setup, app, platform } = facts;
  const checks: Check[] = [SETUP_SOURCE[setup.launchd]];
  if (setup.otherCheckout)
    checks.push({
      status: "warn",
      name: "Checkout",
      detail:
        "the app was set up from another harnexus checkout; run bun run feedback there",
    });
  checks.push({
    status: Object.values(setup.settings).includes("invalid") ? "warn" : "ok",
    name: "Settings",
    detail: Object.entries(setup.settings)
      .map(([key, value]) => `${key}=${value}`)
      .join(" "),
  });
  if (setup.bun !== null) checks.push(appBunCheck(setup.bun, setup.pinnedBun));
  // The app keeps the Codex CLI it started with, so a running bridge that met another version than the one installed means the app was updated while it ran.
  const older = app.runningCodex.filter(
    (version) => app.installedCodex !== null && version !== app.installedCodex,
  );
  checks.push({
    status: older.length > 0 ? "warn" : "ok",
    name: "App process",
    detail:
      app.startedAtMs === null
        ? "not running"
        : `running since ${iso(app.startedAtMs)}${older.length > 0 ? `; its bridges met Codex CLI ${older.join(", ")} while ${app.installedCodex} is installed, so the app was updated while running; quit and reopen it` : ""}`,
  });
  checks.push({
    status: platform.macos === null ? "warn" : "ok",
    name: "Platform",
    detail: `${platform.macos === null ? "not macOS" : `macOS ${platform.macos}`} on ${platform.arch}`,
  });
  return checks;
};

const SETUP_SOURCE: Record<FeedbackFacts["setup"]["launchd"], Check> = {
  registered: {
    status: "ok",
    name: "Setup source",
    detail: "the environment bun run open-app registered for the app",
  },
  none: {
    status: "warn",
    name: "Setup source",
    detail:
      "nothing registered with launchd, so this shell's environment is shown; run bun run open-app",
  },
  unreadable: {
    status: "warn",
    name: "Setup source",
    detail:
      "launchd could not be read, so this shell's environment is shown and the paths may not be the app's",
  },
};

const appBunCheck = (
  bun: { path: string; version: string | null },
  pinned: string | null,
): Check =>
  bun.version === null
    ? {
        status: "fail",
        name: "App's Bun",
        detail: `cannot run ${bun.path}; the app falls back to standard Codex`,
      }
    : {
        status: bun.version === pinned ? "ok" : "warn",
        name: "App's Bun",
        detail: `${bun.version} at ${bun.path}${bun.version === pinned ? "" : `, while harnexus pins ${pinned ?? "no version"}`}`,
      };

const logSection = ({ log, sinceMs }: FeedbackFacts): string[] => {
  if (log.state === "off")
    return [
      "No log: HARNEXUS_LOG_PATH is off; unset it and reopen the app with bun run open-app to keep one",
    ];
  if (log.state === "unreadable") return [`No log: ${log.reason}`];
  const { selection } = log;
  const coverage =
    log.oldestMs === null
      ? "holds no lines"
      : !log.complete
        ? `was read back to ${iso(log.oldestMs)}; older lines were not read`
        : log.oldestMs > sinceMs
          ? `starts at ${iso(log.oldestMs)}, after the window start; older lines were rotated away`
          : `covers the window; its oldest line is from ${iso(log.oldestMs)}`;
  const messages = [...selection.messages]
    .sort(([, a], [, b]) => b - a)
    .map(([method, count]) => `${method} ${count}`);
  return [
    `${log.path} ${coverage}`,
    ...(log.unreadable > 0
      ? [`${log.unreadable} unreadable lines left out`]
      : []),
    ...(log.leftOutFields.length > 0
      ? [`Fields left out as unknown: ${log.leftOutFields.join(", ")}`]
      : []),
    ...(messages.length > 0
      ? [`Relayed messages by method: ${messages.join(", ")}`]
      : []),
    "",
    "-- Startup lines written before the window by bridges in it --",
    ...(selection.context.length > 0 ? selection.context : ["none"]),
    "",
    "-- Lines in the window --",
    ...(selection.window.length > 0 ? selection.window : ["none"]),
    ...(selection.omitted > 0
      ? [
          `${selection.omitted} lines left out to fit an issue, routine ones first; narrow --since and --until to see them`,
        ]
      : []),
  ];
};

// Each known path prints as its role, and any other home or volume keeps only its kind, so a report names no user, project or employer.
export const redactPaths = (
  text: string,
  known: readonly { path: string; name: string }[],
) => {
  let redacted = text;
  for (const { path, name } of [...known]
    .filter(({ path }) => path.length > 1)
    .sort((a, b) => b.path.length - a.path.length)) {
    redacted = redacted.replaceAll(path, name);
  }
  return redacted
    .replace(/\/Users\/[^/\s"',;)]+/g, "/Users/<user>")
    .replace(/\/Volumes\/[^/\n"',;]+(?=\/)/g, "/Volumes/<volume>")
    .replace(/\/Volumes\/[^/\s"',;)<]+/g, "/Volumes/<volume>")
    .replace(/\/home\/[^/\s"',;)]+/g, "/home/<user>");
};

const iso = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const local = (ms: number, offsetMinutes: number) =>
  new Date(ms + offsetMinutes * 60_000)
    .toISOString()
    .replace(/:\d{2}\.\d{3}Z$/, "")
    .replace("T", " ");

const offset = (minutes: number) => {
  const absolute = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
};
