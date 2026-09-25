import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
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
        PWD: cwd,
        // bash as /bin/sh adds SHLVL only when the caller did not pass one.
        SHLVL: "2",
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
    "runs Codex app-server through the bridge on the same stdio",
    async () => {
      const { env, reportPath } = setup({ FAKE_CODEX_EXIT: "3" });
      const args = ["app-server", "--listen", "stdio://"];

      const proc = launch(args, env, { stdin: '{"id":1}\n' });
      const result = await finish(proc);
      const report = await readReport(reportPath);

      expect(result).toMatchObject({ stdout: '{"id":1}\n', exitCode: 3 });
      expect(report.pid).not.toBe(proc.pid);
      expect(report.argv).toEqual(args);
      expect(report.env).toMatchObject({
        DO_NOT_TRACK: "1",
        HARNEXUS_LAUNCHER_ACTIVE: "1",
      });
      expect(result.stderr).toContain('"event":"bridge_started"');
      expect(result.stderr).toContain('"event":"codex_exited"');
    },
    TIMEOUT,
  );

  test(
    "ignores .env and bunfig.toml in the working directory",
    async () => {
      const cwd = join(dir, "project");
      const preloaded = join(dir, "preloaded");
      await mkdir(cwd, { recursive: true });
      await writeFile(join(cwd, ".env"), "HARNEXUS_DOTENV_PROBE=leaked\n");
      await writeFile(join(cwd, "bunfig.toml"), 'preload = ["./pre.ts"]\n');
      await writeFile(
        join(cwd, "pre.ts"),
        `require("node:fs").writeFileSync(${JSON.stringify(preloaded)}, "");\n`,
      );
      const { env, reportPath } = setup();

      const result = await finish(launch(["app-server"], env, { cwd }));
      const report = await readReport(reportPath);

      expect(result.exitCode).toBe(0);
      expect(report.env.HARNEXUS_DOTENV_PROBE).toBeUndefined();
      expect(existsSync(preloaded)).toBe(false);

      // Without the launcher's flags, Bun does pick both files up.
      const control = Bun.spawnSync(
        [BUN, "-e", "process.stdout.write(process.env.HARNEXUS_DOTENV_PROBE)"],
        { cwd, env },
      );
      expect(control.stdout.toString()).toBe("leaked");
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

// Records how it was started, then echoes stdin and exits with FAKE_CODEX_EXIT, or waits for a signal when FAKE_CODEX_MODE=wait.
const FAKE_CODEX = `#!/usr/bin/env -S ${BUN} --no-env-file --config=/dev/null
import { writeFileSync } from "node:fs";
writeFileSync(
  process.env.FAKE_CODEX_REPORT,
  JSON.stringify({
    pid: process.pid,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
  }),
);
if (process.env.FAKE_CODEX_MODE === "wait") {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(await Bun.stdin.text());
  process.exitCode = Number(process.env.FAKE_CODEX_EXIT ?? "0");
}
`;
