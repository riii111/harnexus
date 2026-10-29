import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, TASK_DEPS } from "./cli.ts";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

// A stand-in for claude-cloud: records its arguments, directory and stdin, then prints the next planned output.
const SCRIPT = `#!/usr/bin/env bash
dir="$FAKE_DIR"
n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/count"
printf '%s\\n' "$@" > "$dir/args.$n"
pwd > "$dir/cwd.$n"
cat > "$dir/stdin.$n"
if [ -f "$dir/stderr.$n" ]; then cat "$dir/stderr.$n" >&2; fi
cat "$dir/out.$n"
exit "$(cat "$dir/exit.$n" 2>/dev/null || echo 0)"
`;

const result = (sessionId: string, text: string, isError = false) =>
  JSON.stringify({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    result: text,
    session_id: sessionId,
  });

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "harnexus-cloud-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "fake");
  const work = join(root, "work");
  await mkdir(fake);
  await mkdir(work);
  const bin = join(root, "claude-cloud");
  await writeFile(bin, SCRIPT);
  await chmod(bin, 0o755);
  const prompt = join(root, "prompt.md");
  await writeFile(prompt, "review this diff");
  const env = {
    HARNEXUS_EXECUTION_ENV: "cloud",
    HARNEXUS_CLAUDE_CLOUD_BIN: bin,
    FAKE_DIR: fake,
    XDG_STATE_HOME: join(root, "state"),
    PATH: process.env.PATH,
  };
  const plan = (n: number, out: string, exit = 0, stderr?: string) =>
    Promise.all([
      writeFile(join(fake, `out.${n}`), out),
      writeFile(join(fake, `exit.${n}`), String(exit)),
      stderr === undefined
        ? Promise.resolve()
        : writeFile(join(fake, `stderr.${n}`), stderr),
    ]);
  const run = async (
    argv: readonly string[],
    extra: Record<string, string> = {},
  ) => {
    const done = await runTask(["claude", ...argv], {
      ...TASK_DEPS,
      cwd: work,
      env: { ...env, ...extra },
    });
    return {
      code: done.code,
      out: done.code === 0 ? JSON.parse(done.stdout) : null,
      err: done.stderr,
    };
  };
  const args = async (n: number) =>
    (await readFile(join(fake, `args.${n}`), "utf8")).trim().split("\n");
  return { root, fake, work, prompt, plan, run, args, env };
};

describe("harnexus-task claude", () => {
  test("starts a session, records its id, and resumes it in the same directory", async () => {
    const f = await fixture();
    await f.plan(1, result(FIRST, "started"));
    const started = await f.run([
      "--session",
      "review-1",
      "--start",
      "--prompt-file",
      f.prompt,
    ]);
    expect(started.code).toBe(0);
    expect(started.out).toMatchObject({
      sessionId: FIRST,
      resumed: false,
      result: "started",
      cwd: f.work,
    });
    expect(await f.args(1)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "auto",
    ]);
    expect(await readFile(join(f.fake, "stdin.1"), "utf8")).toBe(
      "review this diff",
    );
    expect(await readFile(join(f.fake, "cwd.1"), "utf8")).toBe(`${f.work}\n`);

    await f.plan(2, result(FIRST, "again"));
    const elsewhere = join(f.root, "elsewhere");
    await mkdir(elsewhere);
    const resumed = await f.run([
      "--session",
      "review-1",
      "--resume",
      "--prompt-file",
      f.prompt,
    ]);
    expect(resumed.out).toMatchObject({
      sessionId: FIRST,
      resumed: true,
      result: "again",
    });
    expect(await f.args(2)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "auto",
      "--resume",
      FIRST,
    ]);
    expect(await readFile(join(f.fake, "cwd.2"), "utf8")).toBe(`${f.work}\n`);

    const state = await f.run(["--session", "review-1"]);
    expect(state.out).toMatchObject({
      sessionId: FIRST,
      turns: 2,
      cwd: f.work,
    });
  });

  test("follows a new session id returned by a resume", async () => {
    const f = await fixture();
    await f.plan(1, result(FIRST, "a"));
    await f.run(["--session", "s", "--start", "--prompt-file", f.prompt]);
    await f.plan(2, result(SECOND, "b"));
    await f.run(["--session", "s", "--resume", "--prompt-file", f.prompt]);
    await f.plan(3, result(SECOND, "c"));
    await f.run(["--session", "s", "--resume", "--prompt-file", f.prompt]);
    expect((await f.args(3)).slice(-2)).toEqual(["--resume", SECOND]);
    const state = await f.run(["--session", "s"]);
    expect(state.out?.history).toEqual([FIRST, SECOND]);
  });

  test("accepts the array form of print output", async () => {
    const f = await fixture();
    await f.plan(
      1,
      JSON.stringify([{ type: "system" }, JSON.parse(result(FIRST, "done"))]),
    );
    const started = await f.run([
      "--session",
      "s",
      "--start",
      "--prompt-file",
      f.prompt,
    ]);
    expect(started.out?.result).toBe("done");
  });

  test("passes a model and the plan permission mode", async () => {
    const f = await fixture();
    await f.plan(1, result(FIRST, "ok"));
    await f.run([
      "--session",
      "s",
      "--start",
      "--prompt-file",
      f.prompt,
      "--model",
      "claude-opus-5-5",
      "--permission-mode",
      "plan",
    ]);
    expect(await f.args(1)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
      "--model",
      "claude-opus-5-5",
    ]);
  });

  test("refuses to start a session twice and to resume one never started", async () => {
    const f = await fixture();
    const missing = await f.run([
      "--session",
      "s",
      "--resume",
      "--prompt-file",
      f.prompt,
    ]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("no recorded Claude session");
    await f.plan(1, result(FIRST, "ok"));
    await f.run(["--session", "s", "--start", "--prompt-file", f.prompt]);
    const again = await f.run([
      "--session",
      "s",
      "--start",
      "--prompt-file",
      f.prompt,
    ]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("use --resume");
  });

  test("reports an unreachable network without recording a session", async () => {
    const f = await fixture();
    await f.plan(
      1,
      "",
      75,
      "claude-cloud: api.anthropic.com に接続できません。",
    );
    const failed = await f.run([
      "--session",
      "s",
      "--start",
      "--prompt-file",
      f.prompt,
    ]);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("nothing was sent");
    expect((await f.run(["--session", "s"])).out?.sessionId).toBeNull();
  });

  test("keeps a started session when its turn reports an error", async () => {
    const f = await fixture();
    await f.plan(1, result(FIRST, "boom", true), 1);
    const failed = await f.run([
      "--session",
      "s",
      "--start",
      "--prompt-file",
      f.prompt,
    ]);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain(`session ${FIRST} is recorded, resume it`);
    expect((await f.run(["--session", "s"])).out?.sessionId).toBe(FIRST);
  });

  test("fails without recording on output with no valid session id", async () => {
    const f = await fixture();
    await f.plan(1, result("not-a-uuid; rm -rf /", "x"));
    const failed = await f.run([
      "--session",
      "s",
      "--start",
      "--prompt-file",
      f.prompt,
    ]);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("session_id");
    expect((await f.run(["--session", "s"])).out?.sessionId).toBeNull();
  });

  test("fails on output that is not JSON", async () => {
    const f = await fixture();
    await f.plan(1, "plain text");
    const failed = await f.run([
      "--session",
      "s",
      "--start",
      "--prompt-file",
      f.prompt,
    ]);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("no result in its output");
  });

  test("names the install step when the Claude wrapper is missing", async () => {
    const f = await fixture();
    const failed = await f.run(
      ["--session", "s", "--start", "--prompt-file", f.prompt],
      {
        HARNEXUS_CLAUDE_CLOUD_BIN: join(f.root, "absent"),
      },
    );
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("install.sh");
  });

  test("refuses a second run while another process holds the session, and takes over a dead holder's lock", async () => {
    const f = await fixture();
    await f.plan(1, result(FIRST, "ok"));
    await f.run(["--session", "s", "--start", "--prompt-file", f.prompt]);
    const dir = join(f.root, "state/taskctl/cloud-claude");
    const [entry] = await Bun.$`ls ${dir}`
      .text()
      .then((t) => t.trim().split("\n"));
    const lock = join(dir, entry ?? "", "lock.json");
    await writeFile(lock, JSON.stringify({ pid: process.pid }));
    const busy = await f.run([
      "--session",
      "s",
      "--resume",
      "--prompt-file",
      f.prompt,
    ]);
    expect(busy.code).toBe(1);
    expect(busy.err).toContain("another claude run");
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345 }));
    await f.plan(2, result(FIRST, "ok"));
    const taken = await f.run([
      "--session",
      "s",
      "--resume",
      "--prompt-file",
      f.prompt,
    ]);
    expect(taken.code).toBe(0);
  });

  test.each([
    {
      name: "a missing session",
      argv: ["--start"],
      message: "--session is required",
    },
    {
      name: "both modes",
      argv: ["--session", "s", "--start", "--resume", "--prompt-file", "/p"],
      message: "only one of",
    },
    {
      name: "a start without a prompt file",
      argv: ["--session", "s", "--start"],
      message: "--prompt-file is required",
    },
    {
      name: "an unknown permission mode",
      argv: ["--session", "s", "--permission-mode", "bypassPermissions"],
      message: "--permission-mode must be one of",
    },
    {
      name: "a session name with a space",
      argv: ["--session", "a b"],
      message: "--session may hold",
    },
  ])("rejects $name", async ({ argv, message }) => {
    const f = await fixture();
    const failed = await f.run(argv);
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain(message);
  });
});
