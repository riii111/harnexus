import { describe, expect, test } from "bun:test";
import {
  cloudCheck,
  failed,
  fallbackCheck,
  formatReport,
  logChecks,
  parseProcesses,
  processChecks,
  refusedCheck,
} from "./doctor-report.ts";

describe("parseProcesses", () => {
  test("reads each ps line into its pid, parent and command", () => {
    const processes = parseProcesses(
      "  101     1 /usr/bin/codex app-server\n  102   101 bun src/bootstrap/main.ts\n",
    );

    expect(processes).toEqual([
      { pid: 101, ppid: 1, command: "/usr/bin/codex app-server" },
      { pid: 102, ppid: 101, command: "bun src/bootstrap/main.ts" },
    ]);
  });
});

describe("cloudCheck", () => {
  test("passes a claude command that offers both flags", () => {
    const check = cloudCheck(
      "claude",
      "  --cloud [description|session_id|url]  Create a cloud session\n  --teleport [session]  Resume a teleport session\n",
      "2.1.314 (Claude Code)\n",
    );

    expect(check.status).toBe("ok");
    expect(check.detail).toContain("offers --cloud and --teleport");
  });

  test.each([
    {
      name: "a command that cannot run",
      help: null,
      expected: "cannot run claude; set HARNEXUS_CLAUDE_CLI",
    },
    {
      name: "a command without --teleport",
      help: "  --cloud [description]  Create a cloud session\n  --teleport-legacy\n",
      expected: "lacks --teleport; update Claude Code",
    },
  ])("warns on $name", ({ help, expected }) => {
    const check = cloudCheck("claude", help, "2.0.0");

    expect(check.status).toBe("warn");
    expect(check.detail).toContain(expected);
  });
});

describe("processChecks", () => {
  test("counts running bridges and the Claude processes they run", () => {
    const checks = processChecks(
      [
        { pid: 100, ppid: 50, command: BRIDGE },
        { pid: 200, ppid: 100, command: CLAUDE },
      ],
      REPO,
    );

    expect(checks).toEqual([
      { status: "ok", name: "Bridges", detail: "1 running" },
      { status: "ok", name: "Claude processes", detail: "1 run by a bridge" },
    ]);
  });

  test("warns about a bridge and a Claude process left under launchd with their pids only", () => {
    const checks = processChecks(
      [
        { pid: 100, ppid: 1, command: `${BRIDGE} secret-prompt` },
        { pid: 200, ppid: 1, command: `${CLAUDE} --prompt secret-prompt` },
      ],
      REPO,
    );

    expect(checks.map(({ status }) => status)).toEqual(["warn", "warn"]);
    expect(checks.map(({ detail }) => detail).join("\n")).toContain("kill 100");
    expect(checks.map(({ detail }) => detail).join("\n")).toContain("kill 200");
    expect(JSON.stringify(checks)).not.toContain("secret-prompt");
  });

  test("leaves out processes that are not this checkout's bridge or Claude", () => {
    const checks = processChecks(
      [
        { pid: 300, ppid: 1, command: "/usr/local/bin/claude" },
        {
          pid: 301,
          ppid: 1,
          command: "bun /other/project/src/bootstrap/main.ts",
        },
        {
          pid: 302,
          ppid: 1,
          command:
            "/other/tool/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
        },
      ],
      REPO,
    );

    expect(checks.map(({ status }) => status)).toEqual(["ok", "ok"]);
  });
});

describe("formatReport", () => {
  test("prints one line per check with its status first", () => {
    const report = formatReport([
      { status: "ok", name: "Bun", detail: "1.3.13" },
      { status: "fail", name: "App", detail: "missing" },
    ]);

    expect(report).toBe("ok   Bun: 1.3.13\nfail App: missing\n");
  });
});

describe("failed", () => {
  test.each([
    { name: "a failed check", status: "fail" as const, expected: true },
    { name: "only warnings", status: "warn" as const, expected: false },
  ])("reports $name as $expected", ({ status, expected }) => {
    expect(failed([{ status, name: "x", detail: "y" }])).toBe(expected);
  });
});

const REPO = "/work/harnexus";

const BRIDGE = `/usr/bin/bun --no-env-file --config=/dev/null ${REPO}/src/bootstrap/main.ts`;

const CLAUDE = `${REPO}/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`;

describe("logChecks", () => {
  test("reports standard fallback without printing its raw log fields", () => {
    const checks = logChecks(
      line("2026-10-09T11:00:00.000Z", {
        event: "standard_fallback",
        reason: "BridgeStartupFailed",
        content: "private",
      }),
      "/state/bridge.log",
      Date.parse("2026-10-09T12:00:00.000Z"),
    );
    expect(checks[0]).toMatchObject({
      status: "warn",
      name: "Standard fallback",
    });
    expect(JSON.stringify(checks)).not.toContain("private");
  });
  test("summarizes starts, the latest Codex CLI, the call socket and refusals of the last 24 hours", () => {
    const checks = logChecks(
      [
        line("2026-10-07T12:00:00.000Z", { event: "bridge_started" }),
        line("2026-10-09T10:00:00.000Z", { event: "bridge_started" }),
        line("2026-10-09T10:00:01.000Z", {
          event: "codex_version",
          version: "0.120.0",
          verified: true,
        }),
        line("2026-10-09T10:00:02.000Z", { event: "call_socket_listening" }),
        line("2026-10-09T11:00:00.000Z", { event: "bridge_started" }),
        line("2026-10-09T11:00:01.000Z", {
          event: "codex_version",
          version: "0.121.0",
          verified: false,
        }),
        line("2026-10-09T11:00:02.000Z", {
          event: "call_socket_unavailable",
          reason: "SocketInUse",
        }),
        line("2026-10-09T11:01:00.000Z", {
          event: "claude_request_refused",
          method: "thread/resume",
          reason: "claude_thread_moved",
        }),
        line("2026-10-09T11:02:00.000Z", {
          event: "claude_turn",
          step: "refused",
          reason: "busy",
          error: null,
        }),
        line("2026-10-09T11:03:00.000Z", {
          event: "claude_request_refused",
          method: "thread/resume",
          reason: "claude_thread_moved",
        }),
        "not json",
        "",
      ].join("\n"),
      "/state/bridge.log",
      Date.parse("2026-10-09T12:00:00.000Z"),
    );

    expect(checks).toEqual([
      {
        status: "ok",
        name: "Standard fallback",
        detail: "none in the last 24h",
      },
      {
        status: "ok",
        name: "Log",
        detail:
          "2 bridge starts in the last 24 hours, Codex CLI 0.121.0 (unchecked), in /state/bridge.log",
      },
      {
        status: "warn",
        name: "Call socket",
        detail: "listening 1, unavailable 1 (SocketInUse)",
      },
      {
        status: "warn",
        name: "Refusals",
        detail:
          "request thread/resume claude_thread_moved 2 (last 2026-10-09T11:03:00.000Z); turn busy 1 (last 2026-10-09T11:02:00.000Z)",
      },
      {
        status: "ok",
        name: "Cloud copies",
        detail: "0 copied, 0 failed in the last 24h",
      },
    ]);
  });

  test("reports nothing seen for a log with no recent events", () => {
    const checks = logChecks(
      line("2026-10-01T00:00:00.000Z", { event: "bridge_started" }),
      "/state/bridge.log",
      Date.parse("2026-10-09T12:00:00.000Z"),
    );

    expect(checks.map(({ status, detail }) => ({ status, detail }))).toEqual([
      { status: "ok", detail: "none in the last 24h" },
      {
        status: "ok",
        detail:
          "0 bridge starts in the last 24 hours, Codex CLI not seen, in /state/bridge.log",
      },
      { status: "ok", detail: "listening 0" },
      { status: "ok", detail: "none" },
      { status: "ok", detail: "0 copied, 0 failed in the last 24h" },
    ]);
  });
});

describe("logChecks Cloud copies", () => {
  test("warns about a chat whose copies stopped and counts the others", () => {
    const checks = logChecks(
      [
        line("2026-10-09T11:00:00.000Z", {
          event: "claude_cloud",
          step: "copied",
          records: 4,
          ms: 900,
        }),
        line("2026-10-09T11:01:00.000Z", {
          event: "claude_cloud",
          step: "copy_ran_model",
        }),
      ].join("\n"),
      "/state/bridge.log",
      Date.parse("2026-10-09T12:00:00.000Z"),
    );

    expect(checks.at(-1)).toEqual({
      status: "warn",
      name: "Cloud copies",
      detail:
        "1 stopped in the last 24h (last 2026-10-09T11:01:00.000Z, copy_ran_model); copies of that chat resume after the bridge restarts",
    });
  });
});

describe("refusedCheck", () => {
  test("warns that a sandbox may have refused an EPERM", () => {
    expect(
      refusedCheck("Processes", "cannot list processes", { code: "EPERM" }),
    ).toEqual({
      status: "warn",
      name: "Processes",
      detail:
        "cannot list processes: not permitted to this shell (EPERM), as in a sandbox; run this outside the sandbox to check",
    });
  });

  test.each([
    {
      name: "file modes refusing it",
      cause: { code: "EACCES" },
      expected: "cannot write to /state: permission denied (EACCES)",
    },
    {
      name: "another failure",
      cause: { code: "ENOENT" },
      expected: "cannot write to /state",
    },
    {
      name: "a cause without a code",
      cause: null,
      expected: "cannot write to /state",
    },
  ])("fails on $name", ({ cause, expected }) => {
    expect(
      refusedCheck("State directory", "cannot write to /state", cause),
    ).toEqual({
      status: "fail",
      name: "State directory",
      detail: expected,
    });
  });
});

const line = (time: string, fields: object) =>
  JSON.stringify({ time, ...fields });

describe("fallbackCheck", () => {
  test("reports the failure record even when no bridge log exists", () => {
    expect(
      fallbackCheck({
        time: "2026-10-16T01:00:00Z",
        reason: "UnverifiedCodex",
        version: "9.0.0",
        content: "secret",
      }),
    ).toEqual({
      status: "warn",
      name: "Last standard fallback",
      detail:
        "2026-10-16T01:00:00Z: UnverifiedCodex; Codex CLI 9.0.0; run bun run open-app after repairing the setup",
    });
  });
  test("discards unexpected text in a damaged failure record", () => {
    expect(
      fallbackCheck({ time: "secret", reason: "secret", version: "secret" }),
    ).toEqual({
      status: "warn",
      name: "Last standard fallback",
      detail: "invalid failure record",
    });
  });
});
