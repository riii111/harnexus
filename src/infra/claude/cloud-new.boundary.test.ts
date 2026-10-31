import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloudSession } from "./cloud-new.boundary.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// A stand-in for claude that prints what --cloud prints, with terminal colors, then waits to be stopped.
const fakeClaude = async (body: string) => {
  const root = await mkdtemp(join(tmpdir(), "harnexus-cloud-new-"));
  roots.push(root);
  const file = join(root, "claude");
  await writeFile(
    file,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${root}/args"\n${body}\nsleep 30\n`,
  );
  await chmod(file, 0o755);
  return { file, root };
};

describe("startCloudSession", () => {
  test("reads the session claude --cloud started and stops it", async () => {
    const { file, root } = await fakeClaude(
      `printf '\\033[1mCreated cloud session: README 要約\\033[0m\\r\\nView: https://claude.ai/code/session_01NfjPqrHtNPEcDZP4SkBFGT?from=cli&m=0\\r\\n'`,
    );
    const started = Date.now();

    const run = await startCloudSession(file, "summarize it", {
      cwd: root,
      env: { PATH: process.env.PATH },
    });

    expect(run.unwrap()).toEqual({
      sessionId: "session_01NfjPqrHtNPEcDZP4SkBFGT",
      title: "README 要約",
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("waits for the whole session id when it is printed in pieces", async () => {
    const { file, root } = await fakeClaude(
      `printf 'View: https://claude.ai/code/session_01AbCdEf'; sleep 0.5; printf 'GhIjKl\\r\\n'`,
    );

    const run = await startCloudSession(file, "summarize it", {
      cwd: root,
      env: { PATH: process.env.PATH },
    });

    expect(run.unwrap().sessionId).toBe("session_01AbCdEfGhIjKl");
  });

  test("fails without terminal colors when claude prints no session in time", async () => {
    const { file, root } = await fakeClaude(
      `printf '\\033[31mStill starting\\033[0m\\n'`,
    );

    const run = await startCloudSession(file, "summarize it", {
      cwd: root,
      env: { PATH: process.env.PATH },
      timeoutMs: 1_000,
    });

    expect(run.isErr() && run.error.message).toBe("Still starting");
  });

  test("says when claude asks to trust the folder", async () => {
    const { file, root } = await fakeClaude(
      `printf 'Quick safety check: Is this a project you created or one you trust?\\n'`,
    );

    const run = await startCloudSession(file, "summarize it", {
      cwd: root,
      env: { PATH: process.env.PATH },
    });

    expect(run.isErr() && run.error.message).toContain("trust");
  });

  test("fails with what claude printed last when it starts nothing", async () => {
    const { file, root } = await fakeClaude(
      `printf 'Not logged in\\n'; exit 1`,
    );

    const run = await startCloudSession(file, "summarize it", {
      cwd: root,
      env: { PATH: process.env.PATH },
      timeoutMs: 5_000,
    });

    expect(run.isErr() && run.error.message).toContain("Not logged in");
  });
});
