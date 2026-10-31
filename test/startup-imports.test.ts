import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

describe("bridge startup imports", () => {
  test("loads no Claude Agent SDK module before a Claude session starts", async () => {
    const modules = [
      "bootstrap/claude-threads.ts",
      "infra/claude/session.ts",
      "infra/codex/codex-link.ts",
    ].map((path) => join(SRC, path));
    const script = `
      for (const path of ${JSON.stringify(modules)}) await import(path);
      console.log(JSON.stringify(Object.keys(require.cache).filter((key) => key.includes("claude-agent-sdk"))));
    `;

    const proc = Bun.spawn(
      [process.execPath, "--no-env-file", "--config=/dev/null", "-e", script],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ exitCode, stderr, loaded: JSON.parse(stdout) }).toEqual({
      exitCode: 0,
      stderr: "",
      loaded: [],
    });
  });
});
