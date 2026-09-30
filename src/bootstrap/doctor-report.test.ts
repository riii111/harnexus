import { describe, expect, test } from "bun:test";
import {
  failed,
  formatReport,
  parseProcesses,
  processChecks,
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
