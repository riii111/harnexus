import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_PATH_ENV, loadCodexPath } from "./config.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-config-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const errorTag = async (env: Record<string, string | undefined>) => {
  const result = await loadCodexPath(env);
  return result.isErr() ? result.error._tag : undefined;
};

describe("loadCodexPath", () => {
  test("returns the path of an executable file", async () => {
    const path = join(dir, "codex");
    await writeFile(path, "");
    await chmod(path, 0o755);

    const result = await loadCodexPath({ [CODEX_PATH_ENV]: path });

    expect(result.isOk() && result.value).toBe(path);
  });

  test("rejects a missing or empty variable", async () => {
    expect(await errorTag({})).toBe("CodexPathMissing");
    expect(await errorTag({ [CODEX_PATH_ENV]: "" })).toBe("CodexPathMissing");
  });

  test("rejects a relative path", async () => {
    expect(await errorTag({ [CODEX_PATH_ENV]: "bin/codex" })).toBe(
      "CodexPathNotAbsolute",
    );
  });

  test("rejects a file that does not exist or is not executable", async () => {
    const path = join(dir, "plain");
    await writeFile(path, "");
    await chmod(path, 0o644);

    expect(await errorTag({ [CODEX_PATH_ENV]: path })).toBe(
      "FileNotExecutable",
    );
    expect(await errorTag({ [CODEX_PATH_ENV]: join(dir, "absent") })).toBe(
      "FileNotExecutable",
    );
  });
});
