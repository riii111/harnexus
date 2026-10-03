import { describe, expect, test } from "bun:test";
import {
  loadLogPath,
  loadShutdownGraceMs,
  loadStatePath,
  loadTracePath,
  loadUnverifiedCodexPolicy,
} from "./config.ts";

describe("loadLogPath", () => {
  test.each([
    { name: "unset", env: {} },
    { name: "empty", env: { HARNEXUS_LOG_PATH: "" } },
  ])("returns null when the variable is $name", ({ env }) => {
    const path = loadLogPath(env);

    expect(path.isOk() && path.value).toBeNull();
  });

  test("returns an absolute path", () => {
    const path = loadLogPath({ HARNEXUS_LOG_PATH: "/var/log/x.log" });

    expect(path.isOk() && path.value).toBe("/var/log/x.log");
  });

  test("rejects a relative path", () => {
    const path = loadLogPath({ HARNEXUS_LOG_PATH: "x.log" });

    expect(path.isErr() && path.error._tag).toBe("LogPathNotAbsolute");
  });
});

describe("loadTracePath", () => {
  test("records nothing when the variable is unset", () => {
    const path = loadTracePath({});

    expect(path.isOk() && path.value).toBeNull();
  });

  test("returns an absolute path", () => {
    const path = loadTracePath({ HARNEXUS_TRACE_PATH: "/tmp/trace.jsonl" });

    expect(path.isOk() && path.value).toBe("/tmp/trace.jsonl");
  });

  test("rejects a relative path", () => {
    const path = loadTracePath({ HARNEXUS_TRACE_PATH: "trace.jsonl" });

    expect(path.isErr() && path.error._tag).toBe("TracePathNotAbsolute");
  });
});

describe("loadStatePath", () => {
  test.each([
    { name: "unset", env: {} },
    { name: "empty", env: { HARNEXUS_STATE_PATH: "" } },
  ])("defaults to the user's state directory when $name", ({ env }) => {
    const path = loadStatePath(env, () => "/Users/fixture");

    expect(path.isOk() && path.value).toBe(
      "/Users/fixture/.local/state/harnexus/threads.json",
    );
  });

  test("returns an absolute path as given", () => {
    const path = loadStatePath({ HARNEXUS_STATE_PATH: "/tmp/t.json" });

    expect(path.isOk() && path.value).toBe("/tmp/t.json");
  });

  test("rejects a relative path", () => {
    const path = loadStatePath({ HARNEXUS_STATE_PATH: "t.json" });

    expect(path.isErr() && path.error._tag).toBe("StatePathNotAbsolute");
  });
});

describe("loadShutdownGraceMs", () => {
  test("accepts a positive integer", () => {
    expect(loadShutdownGraceMs({ HARNEXUS_SHUTDOWN_GRACE_MS: "200" })).toBe(
      200,
    );
  });

  test.each([
    { name: "unset", value: undefined },
    { name: "zero", value: "0" },
    { name: "negative", value: "-1" },
    { name: "fractional", value: "1.5" },
  ])("falls back to 5000 when the value is $name", ({ value }) => {
    expect(loadShutdownGraceMs({ HARNEXUS_SHUTDOWN_GRACE_MS: value })).toBe(
      5000,
    );
  });
});

describe("loadUnverifiedCodexPolicy", () => {
  test.each([
    { name: "pause", value: "pause", expected: "pause" },
    { name: "an unset variable", value: undefined, expected: "warn" },
    { name: "another value", value: "stop", expected: "warn" },
  ])("reads $name as $expected", ({ value, expected }) => {
    expect(
      loadUnverifiedCodexPolicy({ HARNEXUS_UNVERIFIED_CODEX: value }),
    ).toBe(expected);
  });
});
