import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { FEEDBACK_HINT } from "../../task/cli.ts";
import { reportCrash } from "./crash.boundary.ts";

describe("reportCrash", () => {
  test("passes a finished run through unchanged", async () => {
    const run = { code: 2, stdout: "out", stderr: "err" };

    expect(await reportCrash(async () => run)).toEqual(run);
  });

  test("prints only the innermost cause of a panic, then where to report it", async () => {
    const crashed = await reportCrash(async () => {
      const result = await Result.gen(async function* () {
        const run = yield* Result.await(
          Result.gen(async function* () {
            const bun = yield* Result.ok(MISSING_API);
            (bun.markdown as { render: () => void }).render();
            return Result.ok(FINISHED);
          }),
        );
        return Result.ok(run);
      });
      return result.unwrapOr(FINISHED);
    });

    expect(crashed.code).toBe(1);
    expect(crashed.stdout).toBe("");
    expect(crashed.stderr).toStartWith(
      "harnexus-task: unexpected failure: TypeError: ",
    );
    expect(crashed.stderr).toContain("markdown.render");
    expect(crashed.stderr).not.toContain("Panic");
    expect(crashed.stderr).toEndWith(`\n${FEEDBACK_HINT}\n`);
  });
});

const FINISHED = { code: 0, stdout: "", stderr: "" };

// An API an older Bun lacks, read the way the template parser reads Bun.markdown.
const MISSING_API: Record<string, unknown> = {};
