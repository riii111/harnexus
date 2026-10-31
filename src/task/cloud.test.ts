import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTask, TASK_DEPS } from "./cli.ts";
import { createFakeCli } from "./testing/fake-cli.ts";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

const result = (sessionId: string, text: string, isError = false) =>
  JSON.stringify({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    result: text,
    session_id: sessionId,
  });

const fixture = async () => {
  const {
    root,
    fake,
    bin,
    plan: planRun,
    rawArgs,
  } = await createFakeCli("claude-cloud", cleanups);
  const work = join(root, "work");
  await mkdir(work);
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
    planRun(n, { out, exit, ...(stderr === undefined ? {} : { stderr }) });
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
    (await rawArgs(n)).map((arg) =>
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(arg) &&
      arg !== FIRST &&
      arg !== SECOND
        ? "<generated>"
        : arg,
    );
  const sessionDir = (key: string) =>
    join(
      root,
      "state/taskctl/cloud-claude",
      createHash("sha256").update(key).digest("hex").slice(0, 16),
    );
  return {
    root,
    fake,
    work,
    prompt,
    plan,
    run,
    args,
    rawArgs,
    env,
    sessionDir,
  };
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
      "--session-id",
      "<generated>",
    ]);
    expect(await readFile(join(f.fake, "stdin.1"), "utf8")).toBe(
      "review this diff",
    );
    expect(await readFile(join(f.fake, "cwd.1"), "utf8")).toBe(`${f.work}\n`);

    await f.plan(2, result(FIRST, "again"));
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
      "--session-id",
      "<generated>",
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

  test.each([
    {
      name: "a relative HARNEXUS_CLAUDE_CLOUD_BIN",
      env: { HARNEXUS_CLAUDE_CLOUD_BIN: "claude" },
      message: "must be an absolute path",
    },
    {
      name: "a bad HARNEXUS_CLAUDE_TIMEOUT_MS",
      env: { HARNEXUS_CLAUDE_TIMEOUT_MS: "soon" },
      message: "HARNEXUS_CLAUDE_TIMEOUT_MS",
    },
  ])("rejects $name", async ({ env, message }) => {
    const f = await fixture();
    const failed = await f.run([...START, f.prompt], env);
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain(message);
  });
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

const START = ["--session", "s", "--start", "--prompt-file"] as const;
const RESUME = ["--session", "s", "--resume", "--prompt-file"] as const;

// A killed process nobody has reaped yet still answers signal 0, so its state is read instead.
const alive = async (pid: number) => {
  const state = (await Bun.$`ps -o stat= -p ${pid}`.nothrow().text()).trim();
  return state !== "" && !state.startsWith("Z");
};

describe("harnexus-task claude under the session lock", () => {
  test("refuses a second start while the first is running", async () => {
    const f = await fixture();
    const gate = join(f.fake, "gate");
    const slow = join(f.root, "slow-claude");
    await writeFile(
      slow,
      `#!/usr/bin/env bash\ncat > /dev/null\nwhile [ ! -f "${gate}" ]; do sleep 0.05; done\ncat "$FAKE_DIR/out.1"\n`,
    );
    await chmod(slow, 0o755);
    await f.plan(1, result(FIRST, "ok"));
    const first = f.run([...START, f.prompt], {
      HARNEXUS_CLAUDE_CLOUD_BIN: slow,
    });
    await Bun.sleep(300);
    const second = await f.run([...START, f.prompt], {
      HARNEXUS_CLAUDE_CLOUD_BIN: slow,
    });
    expect(second.code).toBe(1);
    expect(second.err).toContain("another claude run");
    await writeFile(gate, "");
    expect((await first).code).toBe(0);
  });

  test("holds the lock until the state is saved", async () => {
    const f = await fixture();
    await f.plan(1, result(FIRST, "ok"));
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      saving = resolve;
    });
    const first = runTask(["claude", ...START, f.prompt], {
      ...TASK_DEPS,
      cwd: f.work,
      env: f.env,
      saveJson: async (path, data, options) => {
        if (path.endsWith("state.json")) {
          saving();
          await held;
        }
        return TASK_DEPS.saveJson(path, data, options);
      },
    });
    await reached;
    const resumed = await f.run([...RESUME, f.prompt]);
    const started = await f.run([...START, f.prompt]);
    release();
    expect((await first).code).toBe(0);
    expect(resumed.err).toContain("another claude run");
    expect(started.err).toContain("another claude run");
  });

  test("leaves a lock another run took in the meantime", async () => {
    const f = await fixture();
    const lock = join(f.sessionDir("s"), "lock.json");
    const thief = join(f.root, "thief-claude");
    await writeFile(
      thief,
      `#!/usr/bin/env bash\ncat > /dev/null\nprintf '{"pid":${process.pid},"token":"other"}' > "${lock}"\ncat "$FAKE_DIR/out.1"\n`,
    );
    await chmod(thief, 0o755);
    await f.plan(1, result(FIRST, "ok"));
    const done = await f.run([...START, f.prompt], {
      HARNEXUS_CLAUDE_CLOUD_BIN: thief,
    });
    expect(done.code).toBe(0);
    expect(JSON.parse(await readFile(lock, "utf8")).token).toBe("other");
  });

  test("takes over a dead holder's lock", async () => {
    const f = await fixture();
    await mkdir(f.sessionDir("s"), { recursive: true });
    const lock = join(f.sessionDir("s"), "lock.json");
    await writeFile(
      lock,
      JSON.stringify({ pid: 2 ** 22 + 999, token: "dead" }),
    );
    await f.plan(1, result(FIRST, "ok"));
    await f.plan(2, result(SECOND, "ok"));
    const both = await Promise.all([
      f.run([...START, f.prompt]),
      f.run(["--session", "t", ...START.slice(2), f.prompt]),
    ]);
    expect(both.map((r) => r.code)).toEqual([0, 0]);
  });
});

describe("harnexus-task claude with an unknown result", () => {
  test("refuses to start again and recovers the same session by adopting it", async () => {
    const f = await fixture();
    await f.plan(1, "not json", 0);
    const lost = await f.run([...START, f.prompt]);
    expect(lost.code).toBe(1);
    expect(lost.err).toContain("without a result");
    expect(lost.err).toContain("--recover");
    const pending = (await f.run(["--session", "s"])).out?.pending;
    const id = pending.sessionId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await f.rawArgs(1)).slice(-2)).toEqual(["--session-id", id]);

    const again = await f.run([...START, f.prompt]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("did not report back");
    expect(await readFile(join(f.fake, "count"), "utf8")).toBe("1\n");

    await f.plan(2, result(id, "continued"));
    const adopted = await f.run([...RESUME, f.prompt, "--recover", "adopt"]);
    expect(adopted.out).toMatchObject({ sessionId: id, result: "continued" });
    expect((await f.rawArgs(2)).slice(-2)).toEqual(["--resume", id]);
    expect((await f.run(["--session", "s"])).out?.pending).toBeNull();
  });

  test.each([
    {
      name: "the network refuses it",
      adopt: async (f: Fixture) => {
        await f.plan(2, "", 75, "network not allowed");
        return f.run([...RESUME, f.prompt, "--recover", "adopt"]);
      },
      message: "nothing was sent",
    },
    {
      name: "claude cannot be spawned",
      adopt: async (f: Fixture) => {
        await writeFile(
          f.env.HARNEXUS_CLAUDE_CLOUD_BIN,
          "#!/nonexistent/interpreter\n",
        );
        return f.run([...RESUME, f.prompt, "--recover", "adopt"]);
      },
      message: "did not finish",
    },
    {
      name: "it fails validation",
      adopt: (f: Fixture) =>
        f.run([...RESUME, f.prompt, "--recover", "adopt", "--cwd", f.root]),
      message: "--cwd cannot change it",
    },
  ])("keeps the lost session when adopting it fails because $name", async ({
    adopt,
    message,
  }) => {
    const f = await fixture();
    await f.plan(1, "not json", 0);
    expect((await f.run([...START, f.prompt])).code).toBe(1);
    const before = (await f.run(["--session", "s"])).out?.pending;
    expect(before?.sessionId).toBeString();

    const refused = await adopt(f);

    expect(refused.code).toBe(1);
    expect(refused.err).toContain(message);
    expect((await f.run(["--session", "s"])).out?.pending).toEqual(before);
    expect((await f.run([...START, f.prompt])).err).toContain(
      "did not report back",
    );
  });

  test("discard releases the pending turn so a start can run", async () => {
    const f = await fixture();
    await f.plan(1, "not json");
    await f.run([...START, f.prompt]);
    await f.plan(2, result(FIRST, "fresh"));
    const fresh = await f.run([...START, f.prompt, "--recover", "discard"]);
    expect(fresh.out).toMatchObject({ sessionId: FIRST, result: "fresh" });
  });

  test("rejects --recover without a pending turn", async () => {
    const f = await fixture();
    const failed = await f.run([...START, f.prompt, "--recover", "discard"]);
    expect(failed.err).toContain("only when a turn is pending");
  });

  test("keeps the pending turn when the state cannot be saved", async () => {
    const f = await fixture();
    await f.plan(1, result(FIRST, "ok"));
    const done = await runTask(["claude", ...START, f.prompt], {
      ...TASK_DEPS,
      cwd: f.work,
      env: f.env,
      saveJson: async (path, data, options) =>
        path.endsWith("state.json")
          ? TASK_DEPS.saveJson("/proc/denied/state.json", data, options)
          : TASK_DEPS.saveJson(path, data, options),
    });
    expect(done.code).toBe(1);
    expect(done.stderr).toContain("--recover");
    expect((await f.run(["--session", "s"])).out?.pending).not.toBeNull();
  });

  test("stops a process that ignores SIGTERM and has a child, then keeps the turn pending", async () => {
    const f = await fixture();
    const stubborn = join(f.root, "stubborn-claude");
    const pids = join(f.root, "pids");
    await writeFile(
      stubborn,
      `#!/usr/bin/env bash\ntrap '' TERM\ncat > /dev/null\nsleep 300 &\necho "$$ $!" > "${pids}"\nwhile true; do sleep 1; done\n`,
    );
    await chmod(stubborn, 0o755);
    const timed = await f.run([...START, f.prompt], {
      HARNEXUS_CLAUDE_CLOUD_BIN: stubborn,
      HARNEXUS_CLAUDE_TIMEOUT_MS: "400",
      HARNEXUS_CLAUDE_KILL_GRACE_MS: "300",
    });
    expect(timed.code).toBe(1);
    expect(timed.err).toContain("timeout");
    const [parent, child] = (await readFile(pids, "utf8"))
      .trim()
      .split(" ")
      .map(Number);
    expect(await alive(process.pid)).toBe(true);
    expect(await alive(parent ?? 0)).toBe(false);
    expect(await alive(child ?? 0)).toBe(false);
    await expect(
      readFile(join(f.sessionDir("s"), "lock.json")),
    ).rejects.toThrow();
    const again = await f.run([...START, f.prompt]);
    expect(again.err).toContain("did not report back");
  });
});

describe("harnexus-task claude settings", () => {
  test("a resume keeps the permission mode the session started with unless one is named", async () => {
    const f = await fixture();
    await f.plan(1, result(FIRST, "a"));
    await f.run([...START, f.prompt, "--permission-mode", "plan"]);
    await f.plan(2, result(FIRST, "b"));
    await f.run([...RESUME, f.prompt]);
    expect(await f.args(2)).toContain("plan");
    await f.plan(3, result(FIRST, "c"));
    const changed = await f.run([
      ...RESUME,
      f.prompt,
      "--permission-mode",
      "auto",
    ]);
    expect(changed.out?.permissionMode).toBe("auto");
    expect((await f.args(3))[4]).toBe("auto");
  });
});
