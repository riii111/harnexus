import { describe, expect, test } from "bun:test";
import {
  LOG_PATH_ENV,
  loadLogPath,
  loadShutdownGraceMs,
  loadStatePath,
  SHUTDOWN_GRACE_ENV,
  STATE_PATH_ENV,
} from "./config.ts";

describe("loadLogPath", () => {
  test.each([
    { name: "unset", env: {} },
    { name: "empty", env: { [LOG_PATH_ENV]: "" } },
  ])("returns null when the variable is $name", ({ env }) => {
    const path = loadLogPath(env);

    expect(path.isOk() && path.value).toBeNull();
  });

  test("returns an absolute path", () => {
    const path = loadLogPath({ [LOG_PATH_ENV]: "/var/log/x.log" });

    expect(path.isOk() && path.value).toBe("/var/log/x.log");
  });

  test("rejects a relative path", () => {
    const path = loadLogPath({ [LOG_PATH_ENV]: "x.log" });

    expect(path.isErr() && path.error._tag).toBe("LogPathNotAbsolute");
  });
});

describe("loadStatePath", () => {
  test("defaults to the user's state directory and rejects a relative path", () => {
    const home = () => "/Users/fixture";
    const unset = loadStatePath({}, home);
    const absolute = loadStatePath({ [STATE_PATH_ENV]: "/tmp/t.json" }, home);
    const relative = loadStatePath({ [STATE_PATH_ENV]: "t.json" }, home);

    expect(unset.isOk() && unset.value).toBe(
      "/Users/fixture/.local/state/harnexus/threads.json",
    );
    expect(absolute.isOk() && absolute.value).toBe("/tmp/t.json");
    expect(relative.isErr() && relative.error._tag).toBe(
      "StatePathNotAbsolute",
    );
  });
});

describe("loadShutdownGraceMs", () => {
  test("accepts a positive integer", () => {
    expect(loadShutdownGraceMs({ [SHUTDOWN_GRACE_ENV]: "200" })).toBe(200);
  });

  test.each([
    { name: "unset", value: undefined },
    { name: "empty", value: "" },
    { name: "zero", value: "0" },
    { name: "negative", value: "-1" },
    { name: "fractional", value: "1.5" },
    { name: "non-numeric", value: "x" },
  ])("falls back to 5000 when the value is $name", ({ value }) => {
    expect(loadShutdownGraceMs({ [SHUTDOWN_GRACE_ENV]: value })).toBe(5000);
  });
});
