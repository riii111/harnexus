import { describe, expect, test } from "bun:test";
import {
  LOG_PATH_ENV,
  loadLogPath,
  loadShutdownGraceMs,
  SHUTDOWN_GRACE_ENV,
} from "./config.ts";

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
