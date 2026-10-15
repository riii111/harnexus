import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { CommandFailed } from "../runtime/process.boundary.ts";
import { reportCompatibilityFailure } from "./compatibility.boundary.ts";

describe("reportCompatibilityFailure", () => {
  test("saves a failure with logging off even when notification launch fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harnexus-compatibility-"));
    const scripts: string[] = [];
    try {
      const reported = await reportCompatibilityFailure(
        {
          event: "codex_incompatible",
          reason: "ModelListResponseChanged",
          version: "1.0.0",
        },
        {
          HARNEXUS_STATE_PATH: join(dir, "threads.json"),
          HARNEXUS_LOG_PATH: "off",
        },
        async (script) => {
          scripts.push(script);
          return Result.err(
            new CommandFailed({
              command: "fixture",
              cause: null,
              message: "fixture notification unavailable",
            }),
          );
        },
      );
      expect(reported.isErr() && reported.error._tag).toBe("CommandFailed");
      expect(
        JSON.parse(
          await readFile(join(dir, "compatibility-failure.json"), "utf8"),
        ),
      ).toMatchObject({
        event: "codex_incompatible",
        reason: "ModelListResponseChanged",
        version: "1.0.0",
        time: expect.any(String),
      });
      expect(scripts).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("attempts notification even when the diagnostic path is invalid", async () => {
    const scripts: string[] = [];
    const reported = await reportCompatibilityFailure(
      {
        event: "codex_incompatible",
        reason: "InitializeResponseChanged",
        version: null,
      },
      { HARNEXUS_STATE_PATH: "relative" },
      async (script) => {
        scripts.push(script);
        return Result.ok();
      },
    );
    expect(reported.isErr() && reported.error._tag).toBe(
      "StatePathNotAbsolute",
    );
    expect(scripts).toHaveLength(1);
  });
});
