import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_PATH_ENV,
  LOG_PATH_ENV,
  loadCodexPath,
  loadLogPath,
  loadShutdownGraceMs,
  SHUTDOWN_GRACE_ENV,
} from "./config.ts";

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

describe("loadLogPath", () => {
  test("returns null when the variable is unset or empty", () => {
    const unset = loadLogPath({});
    const empty = loadLogPath({ [LOG_PATH_ENV]: "" });

    expect(unset.isOk() && unset.value).toBeNull();
    expect(empty.isOk() && empty.value).toBeNull();
  });

  test("returns an absolute path and rejects a relative one", () => {
    const absolute = loadLogPath({ [LOG_PATH_ENV]: "/var/log/x.log" });
    const relative = loadLogPath({ [LOG_PATH_ENV]: "x.log" });

    expect(absolute.isOk() && absolute.value).toBe("/var/log/x.log");
    expect(relative.isErr() && relative.error._tag).toBe("LogPathNotAbsolute");
  });
});

describe("loadShutdownGraceMs", () => {
  test("accepts a positive integer and falls back to 5000 otherwise", () => {
    const grace = (value?: string) =>
      loadShutdownGraceMs({ [SHUTDOWN_GRACE_ENV]: value });

    expect(grace("200")).toBe(200);
    expect([
      grace(),
      grace(""),
      grace("0"),
      grace("-1"),
      grace("1.5"),
      grace("x"),
    ]).toEqual(Array(6).fill(5000));
  });
});
