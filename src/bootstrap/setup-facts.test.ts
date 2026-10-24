import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { collectSetupFacts } from "./setup-facts.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-setup-facts-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      packageManager: "bun@1.4.4",
      dependencies: { zod: "4.4.3", odd: 1 },
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("collectSetupFacts", () => {
  test.each([
    {
      name: "the CLI's version line",
      output: "codex-cli 0.163.0-alpha.10.2",
      expected: "0.163.0-alpha.10.2",
    },
    { name: "text without a version", output: "codex", expected: null },
    {
      name: "a version followed by other text",
      output: "codex-cli 0.163.0;rm -rf ~",
      expected: null,
    },
  ])("reads the Codex CLI version from $name", async ({
    name,
    output,
    expected,
  }) => {
    const codex = join(dir, name.replaceAll(" ", "-"));
    await writeFile(codex, `#!/bin/sh\necho '${output}'\n`);
    await chmod(codex, 0o755);

    const facts = await collectSetupFacts(dir, codex, LAUNCHD);

    expect(facts.codex).toEqual({ path: codex, version: expected });
  });

  test("reads the pins and leaves a Codex CLI that cannot run unknown", async () => {
    const facts = await collectSetupFacts(dir, join(dir, "missing"), LAUNCHD);

    expect(facts.codex).toBeNull();
    expect(facts.pinnedBun).toBe("1.4.4");
    expect(facts.dependencies).toEqual({ zod: "4.4.3" });
  });
});

const LAUNCHD = Result.ok({ env: {}, agent: null });
