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

  const delegated = [
    ["app-server", "generate-ts", "--out", "x"],
    ["-c", "a=b", "app-server", "-c", "c=d", "daemon"],
    ["app-server", "--listen", "unix://"],
    ["app-server", "--listen=ws://127.0.0.1:1"],
    ["exec", "app-server"],
    ["-c", "app-server"],
  ];
  for (const args of delegated) {
    test(
      `hands ${args.join(" ")} to Codex without the bridge`,
      async () => {
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
  }

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

  test(
    "keeps relaying with the log on stderr when the log file is unusable",
    async () => {
      const { env: relative } = setup({ HARNEXUS_LOG_PATH: "bridge.log" });
      const { env: missing } = setup({
        HARNEXUS_LOG_PATH: join(dir, "absent", "bridge.log"),
      });

      const first = await finish(launch(["app-server"], relative));
      const second = await finish(launch(["app-server"], missing));

      expect(first.exitCode).toBe(0);
      expect(first.stderr).toContain('"reason":"LogPathNotAbsolute"');
      expect(second.exitCode).toBe(0);
      expect(second.stderr).toContain('"reason":"LogFileOpenFailed"');
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

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(
      `forwards ${signal} to Codex and ends with the same signal`,
      async () => {
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
  }
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

  for (const [mode, signal] of [
    ["wait", "SIGTERM"],
    ["wait-ignore-term", "SIGKILL"],
  ] as const) {
    test(
      `stops a Codex that ignores the app disconnecting, with ${signal}`,
      async () => {
        const { env, reportPath } = setup({
          HARNEXUS_SHUTDOWN_GRACE_MS: "200",
          FAKE_CODEX_MODE: mode,
        });

        const proc = launch(["app-server"], env);
        await readReport(reportPath);
        const result = await finish(proc);

        expect(result).toMatchObject({ exitCode: null, signal });
        expect(result.stderr).toContain(
          `"event":"server_signaled","signal":"${signal}"`,
        );
      },
      TIMEOUT,
    );
  }

  for (const [mode, signal] of [
    ["close-stdout", "SIGTERM"],
    ["close-stdout-ignore-term", "SIGKILL"],
  ] as const) {
    test(
      `stops a Codex that closes stdout and keeps running, with ${signal}`,
      async () => {
        const { env, reportPath } = setup({
          HARNEXUS_SHUTDOWN_GRACE_MS: "100",
          FAKE_CODEX_MODE: mode,
        });

        const proc = launch(["app-server"], env);
        const report = await readReport(reportPath);
        const result = await finish(proc);

        expect(result).toMatchObject({ exitCode: null, signal });
        expect(result.stderr).toContain('"event":"server_closed"');
        expect(result.stderr).toContain(
          `"event":"server_signaled","signal":"${signal}"`,
        );
        expect(await stopsRunning(report.pid)).toBe(true);
      },
      TIMEOUT,
    );
  }

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
  for (const [label, overrides, expected] of [
    ["a normal exit", {}, { exitCode: 0, signal: null }],
    [
      "a non-zero exit",
      { FAKE_CODEX_EXIT: "3" },
      { exitCode: 3, signal: null },
    ],
    [
      "a signal",
      { FAKE_BURST_SIGNAL: "SIGTERM" },
      { exitCode: null, signal: "SIGTERM" },
    ],
  ] as const) {
    test(
      `delivers every byte Codex wrote before ${label} to an app that keeps reading slowly`,
      async () => {
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
  }
});

describe("refusals", () => {
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

  test("requires an absolute, executable HARNEXUS_CODEX_PATH", async () => {
    const { env: unset } = setup({ HARNEXUS_CODEX_PATH: undefined });
    const { env: relative } = setup({ HARNEXUS_CODEX_PATH: "codex.js" });
    const { env: absent } = setup({ HARNEXUS_CODEX_PATH: join(dir, "none") });

    await expectRefused(["exec"], unset, "HARNEXUS_CODEX_PATH is not set");
    await expectRefused(["exec"], relative, "must be an absolute path");
    await expectRefused(["exec"], absent, "is not an executable file");
  });

  test("requires HARNEXUS_BUN_PATH for app-server", async () => {
    const { env } = setup({ HARNEXUS_BUN_PATH: undefined });

    await expectRefused(["app-server"], env, "HARNEXUS_BUN_PATH is not set");
  });

  test("refuses a Codex path that resolves to the launcher", async () => {
    const link = join(dir, "codex-link");
    await symlink(LAUNCHER, link);
    const { env: direct } = setup({ HARNEXUS_CODEX_PATH: LAUNCHER });
    const { env: linked } = setup({ HARNEXUS_CODEX_PATH: link });

    await expectRefused(["exec"], direct, "points to the launcher itself");
    await expectRefused(["exec"], linked, "points to the launcher itself");
  });

  test(
    "stops when a launched process reaches the launcher again",
    async () => {
      const wrapper = join(dir, "codex-wrapper");
      await writeFile(wrapper, `#!/bin/sh\nexec "${LAUNCHER}" "$@"\n`);
      await chmod(wrapper, 0o755);
      const { env } = setup({ HARNEXUS_CODEX_PATH: wrapper });
      const { env: marked } = setup({ HARNEXUS_LAUNCHER_ACTIVE: "1" });

      await expectRefused(["exec"], env, "recursive launch detected");
      await expectRefused(["app-server"], env, "recursive launch detected");
      await expectRefused(["exec"], marked, "recursive launch detected");
    },
    TIMEOUT,
  );
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
