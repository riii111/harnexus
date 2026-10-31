import { describe, expect, test } from "bun:test";
import type { LogSelection } from "./feedback-log.ts";
import {
  appStartedAt,
  classifyChanges,
  type FeedbackFacts,
  findBridges,
  formatFeedback,
  parseTimeArgument,
  parseTimedProcesses,
  redactPaths,
} from "./feedback-report.ts";

describe("parseTimeArgument", () => {
  test.each([
    { name: "minutes", arg: "30m", expected: NOW - 30 * 60_000 },
    { name: "hours", arg: "2h", expected: NOW - 2 * 3_600_000 },
    { name: "days", arg: "3d", expected: NOW - 3 * 86_400_000 },
    {
      name: "a time with an offset",
      arg: "2026-10-24T18:30+09:00",
      expected: Date.parse("2026-10-24T09:30:00Z"),
    },
    { name: "nothing, as the fallback", arg: undefined, expected: 42 },
  ])("reads $name", ({ arg, expected }) => {
    const parsed = parseTimeArgument("--since", arg, NOW, 42);

    expect(parsed.isOk() && parsed.value).toBe(expected);
  });

  test.each([
    { name: "a bare number", arg: "30" },
    { name: "an unknown unit", arg: "2w" },
    { name: "more than 7 days", arg: "8d" },
    { name: "a future time", arg: "2026-10-25T00:00Z" },
    { name: "a date without a time", arg: "2026-10-24" },
    { name: "text", arg: "yesterday" },
  ])("refuses $name", ({ arg }) => {
    expect(parseTimeArgument("--since", arg, NOW, 0).isErr()).toBe(true);
  });
});

describe("parseTimedProcesses elapsed time", () => {
  test.each([
    { name: "minutes and seconds", etime: "05:07", expected: 307_000 },
    { name: "hours", etime: "02:05:07", expected: 7_507_000 },
    { name: "days", etime: "3-02:05:07", expected: 266_707_000 },
    { name: "something else", etime: "Sat", expected: null },
  ])("reads $name", ({ etime, expected }) => {
    const processes = parseTimedProcesses(`  100     1 ${etime} /usr/bin/bun`);

    expect(processes.map(({ elapsedMs }) => elapsedMs)).toEqual([expected]);
  });
});

describe("findBridges", () => {
  test("keeps this checkout's bridges with their start, and counts another checkout's", () => {
    const processes = parseTimedProcesses(
      [
        `  100     1    10:00 /usr/bin/bun --no-env-file --config=/dev/null ${REPO}/src/bootstrap/main.ts --launcher`,
        `  101     1    20:00 /usr/bin/bun --no-env-file --config=/dev/null /other/harnexus/src/bootstrap/main.ts --launcher`,
        `  102     1    30:00 /usr/bin/bun ${REPO}/src/bootstrap/main.ts`,
        "  103     1    40:00 bun /work/app/src/bootstrap/main.ts --launcher-mode secret-prompt",
      ].join("\n"),
    );

    const bridges = findBridges(processes, REPO, NOW);

    expect(bridges).toEqual({
      mine: [{ pid: 100, startedAtMs: NOW - 600_000 }],
      others: 1,
    });
  });
});

describe("appStartedAt", () => {
  test("takes the app's longest running main process", () => {
    const processes = parseTimedProcesses(
      [
        `  200     1  1-00:00:00 ${APP}/Contents/MacOS/ChatGPT`,
        `  201   200       05:00 ${APP}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper`,
      ].join("\n"),
    );

    expect(appStartedAt(processes, APP, NOW)).toBe(NOW - 86_400_000);
    expect(appStartedAt([], APP, NOW)).toBeNull();
  });
});

describe("classifyChanges", () => {
  test("names changed harnexus code and only counts the rest", () => {
    const changes = classifyChanges(
      [
        " M src/bootstrap/main.ts",
        "M  package.json",
        "R  src/new.ts",
        "src/old.ts",
        " M notes/acme-client.md",
        "?? private-notes.txt",
        "?? src/scratch.ts",
        "",
      ].join("\0"),
    );

    expect(changes).toEqual({
      code: ["src/bootstrap/main.ts", "package.json", "src/new.ts"],
      otherTracked: 1,
      untracked: 2,
    });
  });
});

describe("redactPaths", () => {
  test("names known paths by role and hides other users and volumes", () => {
    const redacted = redactPaths(
      "at /Users/me/work/acme/harnexus/bin and /Users/me/.local/state/harnexus/threads.json, /Users/other/x, /Volumes/Client Disk/y, /Users/me/.bun/bin/bun",
      [
        { path: "/Users/me/work/acme/harnexus", name: "<checkout>" },
        { path: "/Users/me/.local/state/harnexus", name: "<state>" },
        { path: "/Users/me", name: "~" },
      ],
    );

    expect(redacted).toBe(
      "at <checkout>/bin and <state>/threads.json, /Users/<user>/x, /Volumes/<volume>/y, ~/.bun/bin/bun",
    );
  });
});

describe("formatFeedback", () => {
  test.each<{
    name: string;
    overrides: () => Partial<FeedbackFacts>;
    expected: string;
  }>([
    {
      name: "stale when the checkout changed after it started",
      overrides: () => ({
        codeChangedAtMs: NOW - 60_000,
        bridges: {
          mine: [{ pid: 7, startedAtMs: NOW - 3_600_000 }],
          others: 0,
        },
      }),
      expected:
        "warn Running bridges: pid 7 since 2026-10-24T09:00:00Z; 1 run code older than this checkout",
    },
    {
      name: "stale when its start line names another commit or SDK",
      overrides: () => ({
        bridges: { mine: [{ pid: 7, startedAtMs: NOW - 60_000 }], others: 0 },
        loggedStarts: [
          { pid: 7, commit: "0000000000aa", sdk: "0.3.304", codex: null },
        ],
      }),
      expected: "on 0000000000aa; 1 run code older",
    },
    {
      name: "current when it started after the last change on the same commit",
      overrides: () => ({
        codeChangedAtMs: NOW - 7_200_000,
        bridges: { mine: [{ pid: 7, startedAtMs: NOW - 60_000 }], others: 0 },
        loggedStarts: [
          { pid: 7, commit: COMMIT.slice(0, 12), sdk: "0.3.304", codex: null },
        ],
      }),
      expected: "ok   Running bridges: pid 7 since",
    },
    {
      name: "current when HEAD moved but its start line names the same commit",
      overrides: () => ({
        head: { commit: COMMIT, branch: "main", movedAtMs: NOW - 1000 },
        bridges: { mine: [{ pid: 7, startedAtMs: NOW - 60_000 }], others: 0 },
        loggedStarts: [
          { pid: 7, commit: COMMIT.slice(0, 12), sdk: "0.3.304", codex: null },
        ],
      }),
      expected: "ok   Running bridges",
    },
    {
      name: "stale when HEAD moved after it started and it logged no start",
      overrides: () => ({
        head: { commit: COMMIT, branch: "main", movedAtMs: NOW - 1000 },
        bridges: { mine: [{ pid: 7, startedAtMs: NOW - 60_000 }], others: 0 },
      }),
      expected: "warn Running bridges",
    },
  ])("reports a running bridge as $name", ({ overrides, expected }) => {
    const report = formatFeedback(facts(overrides()));

    expect(report).toContain(expected);
  });

  test("warns about bridges running from another harnexus checkout", () => {
    const report = formatFeedback(facts({ bridges: { mine: [], others: 1 } }));

    expect(report).toContain(
      "warn Other bridges: 1 running from another harnexus checkout",
    );
  });

  test("names a local branch only by kind", () => {
    const report = formatFeedback(
      facts({
        head: { commit: COMMIT, branch: "acme/secret-fix", movedAtMs: null },
      }),
    );

    expect(report).toContain(`ok   Commit: ${COMMIT} on a local branch`);
    expect(report).not.toContain("acme");
  });

  test("fails dependencies that differ from the pins", () => {
    const report = formatFeedback(
      facts({
        dependencies: [
          { name: "zod", pinned: "4.4.3", installed: "4.4.3" },
          { name: "better-result", pinned: "3.0.1", installed: null },
        ],
      }),
    );

    expect(report).toContain(
      "fail Dependencies: better-result missing (pinned 3.0.1); run bun install",
    );
  });

  test("warns about an app updated while it runs and a setup from another checkout", () => {
    const base = facts({});
    const report = formatFeedback({
      ...base,
      setup: { ...base.setup, otherCheckout: true },
      app: {
        startedAtMs: NOW - 3_600_000,
        installedCodex: "0.164.0",
        runningCodex: ["0.163.0-alpha.10.2"],
      },
    });

    expect(report).toContain(
      "warn Checkout: the app was set up from another harnexus checkout",
    );
    expect(report).toContain(
      "warn App process: running since 2026-10-24T09:00:00Z; its bridges met Codex CLI 0.163.0-alpha.10.2 while 0.164.0 is installed",
    );
  });

  test("tells an unread launchd from one with nothing registered", () => {
    const base = facts({});
    const unread = formatFeedback({
      ...base,
      setup: { ...base.setup, launchd: "unreadable" },
    });
    const none = formatFeedback({
      ...base,
      setup: { ...base.setup, launchd: "none" },
    });

    expect(unread).toContain("launchd could not be read");
    expect(none).toContain("nothing registered with launchd");
  });

  test("tells a log that starts after the window from one read only in part", () => {
    const rotated = formatFeedback(
      facts({ log: readLog({ oldestMs: NOW - 60_000, complete: true }) }),
    );
    const capped = formatFeedback(
      facts({ log: readLog({ oldestMs: NOW - 60_000, complete: false }) }),
    );

    expect(rotated).toContain(
      "after the window start; older lines were rotated away",
    );
    expect(capped).toContain("older lines were not read");
  });

  test("prints the window in UTC and local time", () => {
    const report = formatFeedback(facts({ offsetMinutes: 540 }));

    expect(report).toContain("local time is UTC+09:00");
    expect(report).toContain(
      "Window 2026-10-24T09:00:00Z to 2026-10-24T10:00:00Z (local 2026-10-24 18:00 to 2026-10-24 19:00)",
    );
  });
});

const NOW = Date.parse("2026-10-24T10:00:00Z");
const REPO = "/Users/me/harnexus";
const APP = "/Applications/ChatGPT.app";
const COMMIT = "9c5270ce375a80cfaa571119c3ee827b280dc778";

const EMPTY_SELECTION: LogSelection = {
  context: [],
  window: [],
  omitted: 0,
  messages: new Map(),
  shapes: [],
};

const readLog = (coverage: {
  oldestMs: number;
  complete: boolean;
}): FeedbackFacts["log"] => ({
  state: "read",
  path: "<state>/bridge.log",
  unreadable: 0,
  leftOutFields: [],
  selection: EMPTY_SELECTION,
  ...coverage,
});

const facts = (overrides: Partial<FeedbackFacts>): FeedbackFacts => ({
  nowMs: NOW,
  offsetMinutes: 0,
  sinceMs: NOW - 3_600_000,
  untilMs: NOW,
  platform: { macos: "26.1", arch: "arm64" },
  head: { commit: COMMIT, branch: "main", movedAtMs: NOW - 86_400_000 },
  current: { sdk: "0.3.304", claudeCode: "2.1.304" },
  changes: { code: [], otherTracked: 0, untracked: 0 },
  dependencies: [],
  codeChangedAtMs: null,
  bridges: { mine: [], others: 0 },
  loggedStarts: [],
  setup: {
    launchd: "registered",
    otherCheckout: false,
    settings: {
      permissionMode: "auto",
      unverifiedCodex: "run",
      statePath: "default",
      logPath: "default",
      callSocket: "default",
    },
    bun: { path: "/Users/me/.bun/bin/bun", version: "1.4.4" },
    pinnedBun: "1.4.4",
  },
  app: { startedAtMs: null, installedCodex: null, runningCodex: [] },
  doctor: [],
  log: { state: "off" },
  protocol: null,
  ...overrides,
});
