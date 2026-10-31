import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, TASK_DEPS } from "./cli.ts";
import { detectEnvironment } from "./environment.ts";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const scratch = async () => {
  const root = await mkdtemp(join(tmpdir(), "harnexus-env-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
};

const listen = async (path: string) => {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
};

describe("detectEnvironment", () => {
  test.each([
    { name: "explicit cloud", env: { HARNEXUS_EXECUTION_ENV: "cloud" } },
    { name: "explicit local", env: { HARNEXUS_EXECUTION_ENV: "local" } },
    {
      name: "explicit local over the Cloud hint",
      env: { HARNEXUS_EXECUTION_ENV: "local", CODEX_ENVIRONMENT_ID: "env_1" },
    },
  ])("takes $name", async ({ env }) => {
    const found = (await detectEnvironment(env)).unwrap();
    expect(found.environment).toBe(env.HARNEXUS_EXECUTION_ENV as "cloud");
    expect(found.source).toBe("explicit");
  });

  test("reads a nonempty CODEX_ENVIRONMENT_ID as Cloud and names it a guess without printing it", async () => {
    const found = (
      await detectEnvironment({ CODEX_ENVIRONMENT_ID: "env_secret_value" })
    ).unwrap();
    expect(found.environment).toBe("cloud");
    expect(found.source).toBe("CODEX_ENVIRONMENT_ID");
    expect(found.note).toContain("not a documented guarantee");
    expect(JSON.stringify(found)).not.toContain("env_secret_value");
  });

  test("reads a Claude Code cloud session as Cloud on Claude", async () => {
    const found = (
      await detectEnvironment({ CLAUDE_CODE_REMOTE: "true" })
    ).unwrap();

    expect(found).toMatchObject({
      environment: "cloud",
      source: "CLAUDE_CODE_REMOTE",
      host: "claude",
    });
  });

  test("reads a session with both Cloud variables as Codex", async () => {
    const found = (
      await detectEnvironment({
        CODEX_ENVIRONMENT_ID: "env_1",
        CLAUDE_CODE_REMOTE: "true",
      })
    ).unwrap();

    expect(found).toMatchObject({
      source: "CODEX_ENVIRONMENT_ID",
      host: "codex",
    });
  });

  test.each([
    { name: "no variable and no socket", env: {} },
    { name: "CLAUDE_CODE_REMOTE=false", env: { CLAUDE_CODE_REMOTE: "false" } },
    { name: "an empty CLAUDE_CODE_REMOTE", env: { CLAUDE_CODE_REMOTE: "" } },
    {
      name: "an empty CODEX_ENVIRONMENT_ID",
      env: { CODEX_ENVIRONMENT_ID: "" },
    },
  ])("is unknown, not Cloud or local, with $name", async ({ env }) => {
    const root = await scratch();
    const found = (
      await detectEnvironment({
        ...env,
        HARNEXUS_CALL_SOCKET: join(root, "none.sock"),
      })
    ).unwrap();

    expect(found.environment).toBe("unknown");
    expect(found.note).toContain("HARNEXUS_EXECUTION_ENV");
  });

  test("names the Cloud an explicit cloud runs on", async () => {
    const found = (
      await detectEnvironment({
        HARNEXUS_EXECUTION_ENV: "cloud",
        CLAUDE_CODE_REMOTE: "true",
      })
    ).unwrap();

    expect(found).toMatchObject({ source: "explicit", host: "claude" });
  });

  test("is local once the harnexus socket accepts a connection", async () => {
    const root = await scratch();
    const path = join(root, "call.sock");
    await listen(path);
    const found = (
      await detectEnvironment({ HARNEXUS_CALL_SOCKET: path })
    ).unwrap();
    expect(found.environment).toBe("local");
    expect(found.source).toBe("harnexus-socket");
  });
});

describe("harnexus-task environment", () => {
  test("prints the detection as JSON", async () => {
    const run = await runTask(["environment"], {
      ...TASK_DEPS,
      env: { HARNEXUS_EXECUTION_ENV: "cloud" },
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      environment: "cloud",
      source: "explicit",
    });
  });

  test("fails on an invalid explicit value", async () => {
    const run = await runTask(["environment"], {
      ...TASK_DEPS,
      env: { HARNEXUS_EXECUTION_ENV: "Cloud" },
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      "HARNEXUS_EXECUTION_ENV must be cloud or local",
    );
  });
});

describe("Cloud refusals", () => {
  test.each([
    { name: "launch", argv: ["launch", "--request", "/x.json"] },
    { name: "review", argv: ["review", "--request", "/x.json"] },
    { name: "resolve", argv: ["resolve", "--request", "/x.json", "--sent"] },
    { name: "name", argv: ["name", "--pr", "1"] },
    { name: "watch", argv: ["watch", "--status"] },
    { name: "state --request", argv: ["state", "--request", "/x.json"] },
  ])("$name names Cloud and the alternative instead of a socket hint", async ({
    argv,
  }) => {
    const run = await runTask(argv, {
      ...TASK_DEPS,
      env: { CODEX_ENVIRONMENT_ID: "env_1" },
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("unavailable in Cloud");
    expect(run.stderr).toContain("harnexus-task claude");
    expect(run.stderr).not.toContain("call socket");
  });

  test("points a Claude Code cloud session to a new cloud session", async () => {
    const run = await runTask(["launch", "--request", "/x.json"], {
      ...TASK_DEPS,
      env: { CLAUDE_CODE_REMOTE: "true" },
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("unavailable in Cloud");
    expect(run.stderr).toContain("create_session");
  });
});
