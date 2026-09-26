import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER = join(import.meta.dir, "..", "bin", "harnexus-codex");
const BUN = process.execPath;
const TIMEOUT = 20_000;

let dir: string;
let fakeCodex: string;
let reports = 0;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "harnexus-launcher-")));
  fakeCodex = join(dir, "codex.js");
  await writeFile(fakeCodex, FAKE_CODEX);
  await chmod(fakeCodex, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("delegation to the standard Codex", () => {
  test(
    "execs Codex keeping args, cwd, env, stdio and exit code",
    async () => {
      const cwd = join(dir, "work");
      await mkdir(cwd, { recursive: true });
      const { env, reportPath } = setup({
        FAKE_CODEX_EXIT: "7",
        CALLER_VALUE: "kept as is",
      });
      const args = ["exec", "--flag", "with space", ""];

      const proc = launch(args, env, { cwd, stdin: "hello\n" });
      const result = await finish(proc);
      const report = await readReport(reportPath);

      expect(result).toMatchObject({ stdout: "hello\n", exitCode: 7 });
      expect(report.pid).toBe(proc.pid);
      expect(report.argv).toEqual(args);
      expect(report.cwd).toBe(cwd);
      expect(report.env).toEqual({ ...env, HARNEXUS_LAUNCHER_ACTIVE: "1" });
    },
    TIMEOUT,
  );

  test(
    "lets the caller see the signal that ended Codex",
    async () => {
      const { env, reportPath } = setup({ FAKE_CODEX_MODE: "wait" });

      const proc = launch(["exec"], env);
      await readReport(reportPath);
      proc.kill("SIGTERM");
      const result = await finish(proc);

      expect(result).toMatchObject({ exitCode: null, signal: "SIGTERM" });
    },
    TIMEOUT,
  );
});

describe("app-server", () => {
  test(
    "keeps Codex as the started process and relays through the bridge beside it",
    async () => {
      const { env, reportPath } = setup({ FAKE_CODEX_EXIT: "3" });
      const args = ["app-server", "--listen", "stdio://"];
      const input = '{"id":1,"method":"m"}\nnot json\n';

      const proc = launch(args, env, { stdin: input });
      const result = await finish(proc);
      const report = await readReport(reportPath);

      expect(result).toMatchObject({ stdout: input, exitCode: 3 });
      expect(report.pid).toBe(proc.pid);
      expect(report.argv).toEqual(args);
      expect(report.env).toEqual({ ...env, HARNEXUS_LAUNCHER_ACTIVE: "1" });
      expect(result.stderr).toContain('"event":"bridge_started"');
      expect(result.stderr).toContain(
        '"direction":"app_to_server","kind":"request","method":"m"',
      );
      expect(result.stderr).toContain(
        '"direction":"server_to_app","kind":"request","method":"m"',
      );
      expect(result.stderr).toContain('"event":"rpc_unobserved"');
      expect(result.stderr).toContain('"event":"server_closed"');
    },
    TIMEOUT,
  );

  test(
    "finds app-server after global options, as the app starts it",
    async () => {
      const { env, reportPath } = setup();
      const args = [
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--analytics-default-enabled",
        "-c",
        "plugins.x.enabled=true",
      ];

      const proc = launch(args, env);
      const result = await finish(proc);
      const report = await readReport(reportPath);

      expect(result.exitCode).toBe(0);
      expect(report.pid).toBe(proc.pid);
      expect(report.argv).toEqual(args);
      expect(result.stderr).toContain('"event":"bridge_started"');
    },
    TIMEOUT,
  );

  test.each<{ name: string; args: string[] }>([
    {
      name: "an app-server subcommand",
      args: ["app-server", "generate-ts", "--out", "x"],
    },
    {
      name: "the daemon subcommand after config overrides",
      args: ["-c", "a=b", "app-server", "-c", "c=d", "daemon"],
    },
    {
      name: "a unix socket listener",
      args: ["app-server", "--listen", "unix://"],
    },
    {
      name: "a websocket listener",
      args: ["app-server", "--listen=ws://127.0.0.1:1"],
    },
    { name: "app-server as an exec argument", args: ["exec", "app-server"] },
    { name: "app-server as a config value", args: ["-c", "app-server"] },
  ])(
    "hands $name to Codex without the bridge",
    async ({ args }) => {
      const { env, reportPath } = setup();

      const proc = launch(args, env);
      const result = await finish(proc);
      const report = await readReport(reportPath);

      expect(result.exitCode).toBe(0);
      expect(report.pid).toBe(proc.pid);
      expect(report.argv).toEqual(args);
      expect(result.stderr).not.toContain("bridge_started");
    },
    TIMEOUT,
  );

  test(
    "answers a Claude turn itself and relays the other lines to Codex",
    async () => {
      const { env } = setup();
      const claudeTurn = JSON.stringify({
        id: 1,
        method: "turn/start",
        params: {
          threadId: "th-unknown",
          model: "claude-sonnet-5",
          input: [{ type: "text", text: "hello" }],
        },
      });
      const codexLine = JSON.stringify({ id: 2, method: "fixture/ping" });

      const proc = launch(["app-server"], env, {
        stdin: `${claudeTurn}\n${codexLine}\n`,
      });
      const result = await finish(proc);
      const lines = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(lines).toContainEqual(JSON.parse(codexLine));
      expect(lines).toContainEqual({
        id: 1,
        error: { code: -32600, message: expect.any(String) },
      });
      expect(result.stdout).not.toContain("turn/start");
    },
    TIMEOUT,
  );

  test(
    "relays everything without Claude when the state path is unusable",
    async () => {
      const { env } = setup({ HARNEXUS_STATE_PATH: "threads.json" });
      const claudeTurn = `${JSON.stringify({
        id: 1,
        method: "turn/start",
        params: { threadId: "t", model: "claude-sonnet-5" },
      })}\n`;

      const proc = launch(["app-server"], env, { stdin: claudeTurn });
      const result = await finish(proc);

      expect(result.stdout).toBe(claudeTurn);
      expect(result.stderr).toContain('"reason":"StatePathNotAbsolute"');
    },
    TIMEOUT,
  );

  test(
    "also appends the log to HARNEXUS_LOG_PATH, readable only by the owner",
    async () => {
      const logPath = join(dir, "owner-only.log");
      const { env } = setup({ HARNEXUS_LOG_PATH: logPath });

      const result = await finish(
        launch(["app-server"], env, { stdin: '{"id":1,"method":"m"}\n' }),
      );
      const logged = await Bun.file(logPath).text();

      expect(result.exitCode).toBe(0);
      expect(logged).toContain('"event":"bridge_started"');
      expect(logged).toContain('"method":"m"');
      expect(logged).toContain('"event":"server_closed"');
      expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    },
    TIMEOUT,
  );

  test.each([
    {
      name: "a relative path",
      logPath: () => "bridge.log",
      expected: "LogPathNotAbsolute",
    },
    {
      name: "a path in a missing directory",
      logPath: () => join(dir, "absent", "bridge.log"),
      expected: "LogFileOpenFailed",
    },
  ])(
    "keeps relaying with the log on stderr when HARNEXUS_LOG_PATH is $name",
    async ({ logPath, expected }) => {
      const { env } = setup({ HARNEXUS_LOG_PATH: logPath() });

      const result = await finish(launch(["app-server"], env));

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(`"reason":"${expected}"`);
      expect(existsSync(join(dir, "bridge.log"))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "ignores .env and bunfig.toml in the working directory",
    async () => {
      const cwd = join(dir, "project");
      const preloaded = join(dir, "preloaded");
      const leakedLog = join(dir, "dotenv.log");
      await mkdir(cwd, { recursive: true });
      await writeFile(join(cwd, ".env"), `HARNEXUS_LOG_PATH=${leakedLog}\n`);
      await writeFile(join(cwd, "bunfig.toml"), 'preload = ["./pre.ts"]\n');
      await writeFile(
        join(cwd, "pre.ts"),
        `require("node:fs").writeFileSync(${JSON.stringify(preloaded)}, "");\n`,
      );
      const { env } = setup();

      const result = await finish(launch(["app-server"], env, { cwd }));

      // A bridge that loaded .env would also write its log to that path.
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('"event":"bridge_started"');
      expect(existsSync(leakedLog)).toBe(false);
      expect(existsSync(preloaded)).toBe(false);

      // Without the launcher's flags, Bun does pick both files up.
      const control = Bun.spawnSync(
        [BUN, "-e", "process.stdout.write(process.env.HARNEXUS_LOG_PATH)"],
        { cwd, env },
      );
      expect(control.stdout.toString()).toBe(leakedLog);
      expect(existsSync(preloaded)).toBe(true);
    },
    TIMEOUT,
  );

  test.each([{ signal: "SIGTERM" as const }, { signal: "SIGINT" as const }])(
    "forwards $signal to Codex and ends with the same signal",
    async ({ signal }) => {
      const { env, reportPath } = setup({ FAKE_CODEX_MODE: "wait" });

      const proc = launch(["app-server"], env);
      const report = await readReport(reportPath);
      proc.kill(signal);
      const result = await finish(proc);

      expect(result).toMatchObject({ exitCode: null, signal });
      expect(isAlive(report.pid)).toBe(false);
    },
    TIMEOUT,
  );
});

describe("app-server shutdown", () => {
  test(
    "lets the caller see the signal that ended Codex and then closes the output",
    async () => {
      const { env, reportPath } = setup({
        FAKE_CODEX_MODE: "wait",
      });

      const proc = launch(["app-server"], env);
      await readReport(reportPath);
      proc.kill("SIGTERM");
      const result = await finish(proc);

      expect(result).toMatchObject({ exitCode: null, signal: "SIGTERM" });
      expect(result.stderr).toContain('"event":"server_closed"');
    },
    TIMEOUT,
  );

  test.each([
    { name: "exits on SIGTERM", mode: "wait", expected: "SIGTERM" },
    {
      name: "also ignores SIGTERM",
      mode: "wait-ignore-term",
      expected: "SIGKILL",
    },
  ])(
    "signals $expected to a Codex that ignores the app disconnecting and $name",
    async ({ mode, expected }) => {
      const { env, reportPath } = setup({
        HARNEXUS_SHUTDOWN_GRACE_MS: "200",
        FAKE_CODEX_MODE: mode,
      });

      const proc = launch(["app-server"], env);
      await readReport(reportPath);
      const result = await finish(proc);

      expect(result).toMatchObject({ exitCode: null, signal: expected });
      expect(result.stderr).toContain(
        `"event":"server_signaled","signal":"${expected}"`,
      );
    },
    TIMEOUT,
  );

  test.each([
    { name: "exits on SIGTERM", mode: "close-stdout", expected: "SIGTERM" },
    {
      name: "ignores SIGTERM",
      mode: "close-stdout-ignore-term",
      expected: "SIGKILL",
    },
  ])(
    "signals $expected to a Codex that closes stdout, keeps running and $name",
    async ({ mode, expected }) => {
      const { env, reportPath } = setup({
        HARNEXUS_SHUTDOWN_GRACE_MS: "100",
        FAKE_CODEX_MODE: mode,
      });

      const proc = launch(["app-server"], env);
      const report = await readReport(reportPath);
      const result = await finish(proc);

      expect(result).toMatchObject({ exitCode: null, signal: expected });
      expect(result.stderr).toContain('"event":"server_closed"');
      expect(result.stderr).toContain(
        `"event":"server_signaled","signal":"${expected}"`,
      );
      expect(await stopsRunning(report.pid)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "ends Codex when the bridge dies",
    async () => {
      const { env, reportPath } = setup({});
      const proc = Bun.spawn([LAUNCHER, "app-server"], {
        cwd: dir,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      await readReport(reportPath);
      const bridge = childPids(proc.pid);

      expect(bridge).toHaveLength(1);
      process.kill(bridge[0] ?? -1, "SIGKILL");
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(await stopsRunning(bridge[0] ?? -1)).toBe(true);
    },
    TIMEOUT,
  );
});

describe("app-server output at exit", () => {
  test.each([
    {
      name: "a normal exit",
      overrides: {},
      expected: { exitCode: 0, signal: null },
    },
    {
      name: "a non-zero exit",
      overrides: { FAKE_CODEX_EXIT: "3" },
      expected: { exitCode: 3, signal: null },
    },
    {
      name: "a signal",
      overrides: { FAKE_BURST_SIGNAL: "SIGTERM" },
      expected: { exitCode: null, signal: "SIGTERM" },
    },
  ])(
    "delivers every byte Codex wrote before $name to an app that keeps reading slowly",
    async ({ overrides, expected }) => {
      const { env } = setup({
        FAKE_CODEX_MODE: "burst",
        FAKE_BURST_LINES: String(BURST_LINES),
        ...overrides,
      });
      const proc = Bun.spawn([LAUNCHER, "app-server"], {
        cwd: dir,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });

      const received = await readSlowly(proc.stdout);
      await proc.exited;

      expect({ exitCode: proc.exitCode, signal: proc.signalCode }).toEqual(
        expected,
      );
      expect(received === BURST_OUTPUT).toBe(true);
    },
    TIMEOUT,
  );
});

describe("refusals", () => {
  test.each([
    {
      name: "unset",
      codexPath: () => undefined,
      expected: "HARNEXUS_CODEX_PATH is not set",
    },
    {
      name: "relative",
      codexPath: () => "codex.js",
      expected: "must be an absolute path",
    },
    {
      name: "not an existing file",
      codexPath: () => join(dir, "none"),
      expected: "is not an executable file",
    },
  ])("refuses a HARNEXUS_CODEX_PATH that is $name", async ({
    codexPath,
    expected,
  }) => {
    const { env } = setup({ HARNEXUS_CODEX_PATH: codexPath() });

    await expectRefused(["exec"], env, expected);
  });

  test("requires HARNEXUS_BUN_PATH for app-server", async () => {
    const { env } = setup({ HARNEXUS_BUN_PATH: undefined });

    await expectRefused(["app-server"], env, "HARNEXUS_BUN_PATH is not set");
  });

  test("refuses the launcher as the Codex path", async () => {
    const { env } = setup({ HARNEXUS_CODEX_PATH: LAUNCHER });

    await expectRefused(["exec"], env, "points to the launcher itself");
  });

  test("refuses a symlink to the launcher as the Codex path", async () => {
    const link = join(dir, "codex-link");
    await symlink(LAUNCHER, link);
    const { env } = setup({ HARNEXUS_CODEX_PATH: link });

    await expectRefused(["exec"], env, "points to the launcher itself");
  });

  test.each([{ command: "exec" }, { command: "app-server" }])(
    "stops $command when the launched Codex reaches the launcher again",
    async ({ command }) => {
      const wrapper = join(dir, `codex-wrapper-${command}`);
      await writeFile(wrapper, `#!/bin/sh\nexec "${LAUNCHER}" "$@"\n`);
      await chmod(wrapper, 0o755);
      const { env } = setup({ HARNEXUS_CODEX_PATH: wrapper });

      await expectRefused([command], env, "recursive launch detected");
    },
    TIMEOUT,
  );

  test("stops when the launcher is already marked active", async () => {
    const { env } = setup({ HARNEXUS_LAUNCHER_ACTIVE: "1" });

    await expectRefused(["exec"], env, "recursive launch detected");
  });
});

const setup = (overrides: Record<string, string | undefined> = {}) => {
  reports += 1;
  const reportPath = join(dir, `report-${reports}.json`);
  const env: Record<string, string> = {};
  const entries = Object.entries({
    PATH: "/usr/bin:/bin",
    HARNEXUS_CODEX_PATH: fakeCodex,
    HARNEXUS_BUN_PATH: BUN,
    HARNEXUS_STATE_PATH: join(dir, `threads-${reports}.json`),
    FAKE_CODEX_REPORT: reportPath,
    ...overrides,
  });
  for (const [key, value] of entries) {
    if (value !== undefined) env[key] = value;
  }
  return { env, reportPath };
};

const expectRefused = async (
  args: string[],
  env: Record<string, string>,
  message: string,
) => {
  const result = await finish(launch(args, env));
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
};

const launch = (
  args: string[],
  env: Record<string, string>,
  options: { cwd?: string; stdin?: string } = {},
) =>
  Bun.spawn([LAUNCHER, ...args], {
    cwd: options.cwd ?? dir,
    env,
    stdin: new Blob([options.stdin ?? ""]),
    stdout: "pipe",
    stderr: "pipe",
  });

const finish = async (proc: ReturnType<typeof launch>) => {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr, exitCode: proc.exitCode, signal: proc.signalCode };
};

const readReport = async (path: string): Promise<Report> => {
  for (let i = 0; i < 200 && !existsSync(path); i++) await Bun.sleep(25);
  return JSON.parse(await Bun.file(path).text());
};

// About 4 MB, far above a pipe's capacity, so Codex exits while most of its output is still on the way.
const BURST_LINES = 4000;
const BURST_OUTPUT = `${Array.from(
  { length: BURST_LINES },
  (_, i) => `${i} ${"x".repeat(1000)}\n`,
).join("")}END\n`;

const readSlowly = async (stream: ReadableStream<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
    await Bun.sleep(1);
  }
  return Buffer.concat(chunks).toString();
};

const childPids = (pid: number) =>
  Bun.spawnSync(["pgrep", "-P", String(pid)])
    .stdout.toString()
    .split("\n")
    .filter((line) => line !== "")
    .map(Number);

// The killed bridge can linger as a zombie until it is reaped, which kill(pid, 0) still reports as alive.
const stopsRunning = async (pid: number) => {
  for (let i = 0; i < 200; i++) {
    const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    if (state === "" || state.startsWith("Z")) return true;
    await Bun.sleep(25);
  }
  return false;
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type Report = {
  pid: number;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
};

// Records how it was started (renamed into place so readReport never sees a partial write), then echoes stdin and exits with FAKE_CODEX_EXIT, or waits for a signal when FAKE_CODEX_MODE=wait.
const FAKE_CODEX = `#!/usr/bin/env -S ${BUN} --no-env-file --config=/dev/null
import { closeSync, renameSync, writeFileSync } from "node:fs";
const report = process.env.FAKE_CODEX_REPORT;
writeFileSync(
  report + ".tmp",
  JSON.stringify({
    pid: process.pid,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
  }),
);
renameSync(report + ".tmp", report);
if (process.env.FAKE_CODEX_MODE === "burst") {
  const line = "x".repeat(1000);
  for (let i = 0; i < Number(process.env.FAKE_BURST_LINES); i++) {
    if (!process.stdout.write(i + " " + line + "\\n")) {
      await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
  }
  await new Promise((resolve) => process.stdout.write("END\\n", resolve));
  if (process.env.FAKE_BURST_SIGNAL) process.kill(process.pid, process.env.FAKE_BURST_SIGNAL);
  process.exit(Number(process.env.FAKE_CODEX_EXIT ?? "0"));
} else if (process.env.FAKE_CODEX_MODE?.startsWith("close-stdout")) {
  closeSync(1);
  if (process.env.FAKE_CODEX_MODE === "close-stdout-ignore-term") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_CODEX_MODE === "wait" || process.env.FAKE_CODEX_MODE === "wait-ignore-term") {
  if (process.env.FAKE_CODEX_MODE === "wait-ignore-term") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(await Bun.stdin.text());
  process.exitCode = Number(process.env.FAKE_CODEX_EXIT ?? "0");
}
`;
