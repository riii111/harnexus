import { describe, expect, test } from "bun:test";
import {
  loadCallerSocketPath,
  loadCallSocketPath,
  loadLogPath,
  loadPermissionMode,
  loadShutdownGraceMs,
  loadStatePath,
  loadUnverifiedCodexPolicy,
  loadVertexModels,
} from "./config.ts";

describe("loadPermissionMode", () => {
  test.each([
    { name: "unset", value: undefined, expected: "auto" },
    { name: "empty", value: "", expected: "auto" },
    { name: "manual", value: "default", expected: "default" },
    { name: "automatic", value: "auto", expected: "auto" },
  ])("uses $expected approvals when $name", ({ value, expected }) => {
    const loaded = loadPermissionMode({ HARNEXUS_PERMISSION_MODE: value });

    expect(loaded.isOk() && loaded.value).toBe(expected);
  });

  test.each([
    { name: "bypass permissions", value: "bypassPermissions" },
    { name: "a misspelling", value: "atuo" },
  ])("rejects $name instead of changing approval behavior", ({ value }) => {
    const loaded = loadPermissionMode({ HARNEXUS_PERMISSION_MODE: value });

    expect(loaded.isErr() && loaded.error._tag).toBe("PermissionModeInvalid");
  });
});

describe("loadLogPath", () => {
  test("keeps no file when the variable is off", () => {
    const path = loadLogPath({ HARNEXUS_LOG_PATH: "off" }, STATE);

    expect(path.isOk() && path.value).toBeNull();
  });

  test.each([
    { name: "unset", value: undefined },
    { name: "empty", value: "" },
  ])("places the log beside the thread store when $name", ({ value }) => {
    const path = loadLogPath({ HARNEXUS_LOG_PATH: value }, STATE);

    expect(path.isOk() && path.value).toEqual({
      path: "/state/harnexus/bridge.log",
      explicit: false,
    });
  });

  test("returns an absolute path as given", () => {
    const path = loadLogPath({ HARNEXUS_LOG_PATH: "/var/log/x.log" }, STATE);

    expect(path.isOk() && path.value).toEqual({
      path: "/var/log/x.log",
      explicit: true,
    });
  });

  test("rejects a relative path", () => {
    const path = loadLogPath({ HARNEXUS_LOG_PATH: "x.log" }, STATE);

    expect(path.isErr() && path.error._tag).toBe("LogPathNotAbsolute");
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

describe("loadVertexModels", () => {
  test.each([
    { name: "on", env: { HARNEXUS_VERTEX: "on" }, expected: true },
    { name: "unset", env: {}, expected: false },
    { name: "another value", env: { HARNEXUS_VERTEX: "1" }, expected: false },
  ])("lists the Vertex AI models only when the variable is on: $name", ({
    env,
    expected,
  }) => {
    expect(loadVertexModels(env)).toBe(expected);
  });
});

describe("loadCallSocketPath", () => {
  test("keeps the socket closed when the variable is off", () => {
    const path = loadCallSocketPath({ HARNEXUS_CALL_SOCKET: "off" }, STATE);

    expect(path.isOk() && path.value).toBeNull();
  });

  test.each([
    { name: "unset", value: undefined },
    { name: "empty", value: "" },
    { name: "on", value: "on" },
  ])("places the socket beside the thread store when $name", ({ value }) => {
    const path = loadCallSocketPath({ HARNEXUS_CALL_SOCKET: value }, STATE);

    expect(path.isOk() && path.value).toBe("/state/harnexus/call.sock");
  });

  test("uses an absolute path as given", () => {
    const path = loadCallSocketPath(
      { HARNEXUS_CALL_SOCKET: "/tmp/h.sock" },
      STATE,
    );

    expect(path.isOk() && path.value).toBe("/tmp/h.sock");
  });

  test("rejects a relative path", () => {
    const path = loadCallSocketPath({ HARNEXUS_CALL_SOCKET: "h.sock" }, STATE);

    expect(path.isErr() && path.error._tag).toBe("CallSocketPathNotAbsolute");
  });
});

const STATE = "/state/harnexus/threads.json";

describe("loadCallerSocketPath", () => {
  test.each([
    {
      name: "an absolute socket path",
      env: { HARNEXUS_CALL_SOCKET: "/run/h/call.sock" },
      expected: "/run/h/call.sock",
    },
    {
      name: "on beside the configured thread store",
      env: {
        HARNEXUS_CALL_SOCKET: "on",
        HARNEXUS_STATE_PATH: "/s/h/state.json",
      },
      expected: "/s/h/call.sock",
    },
    {
      name: "nothing beside the default thread store",
      env: {},
      expected: "/home/u/.local/state/harnexus/call.sock",
    },
  ])("finds the socket for $name", ({ env, expected }) => {
    const path = loadCallerSocketPath(env, () => "/home/u");

    expect(path.isOk() && path.value).toBe(expected);
  });
});
