import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { runProcess } from "./run.boundary.ts";

describe("runProcess", () => {
  test("keeps a character whose bytes arrive in separate chunks, on stdout and stderr", async () => {
    // "あ" is e3 81 82; its first byte is written alone, then the rest after a pause.
    const script =
      "printf '{\"text\":\"\\343'; sleep 0.2; printf '\\201\\202\"}'; printf '\\343' >&2; sleep 0.2; printf '\\201\\202' >&2";

    const run = await runProcess("/bin/sh", ["-c", script], "", {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH },
      timeoutMs: 10_000,
      killGraceMs: 1_000,
    });

    expect(run.unwrap()).toMatchObject({
      status: 0,
      stdout: '{"text":"あ"}',
      stderr: "あ",
    });
  });
});
