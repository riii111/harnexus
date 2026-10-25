import { describe, expect, test } from "bun:test";
import { bridgeSettings } from "./bridge-identity.ts";

describe("bridgeSettings", () => {
  test("reads an empty environment as every default", () => {
    expect(bridgeSettings({})).toEqual({
      permissionMode: "auto",
      unverifiedCodex: "run",
      statePath: "default",
      logPath: "default",
      callSocket: "default",
    });
  });

  test("names custom paths only by kind", () => {
    const settings = bridgeSettings({
      HARNEXUS_PERMISSION_MODE: "default",
      HARNEXUS_UNVERIFIED_CODEX: "fallback",
      HARNEXUS_STATE_PATH: "/Users/someone/state/threads.json",
      HARNEXUS_LOG_PATH: "/Users/someone/logs/bridge.log",
      HARNEXUS_CALL_SOCKET: "/Users/someone/call.sock",
    });

    expect(settings).toEqual({
      permissionMode: "default",
      unverifiedCodex: "fallback",
      statePath: "custom",
      logPath: "custom",
      callSocket: "custom",
    });
    expect(JSON.stringify(settings)).not.toContain("someone");
  });

  test("tells off and invalid values apart", () => {
    expect(
      bridgeSettings({
        HARNEXUS_PERMISSION_MODE: "yolo",
        HARNEXUS_LOG_PATH: "off",
        HARNEXUS_CALL_SOCKET: "relative.sock",
      }),
    ).toMatchObject({
      permissionMode: "invalid",
      logPath: "off",
      callSocket: "invalid",
    });
    expect(
      bridgeSettings({ HARNEXUS_STATE_PATH: "relative/threads.json" }),
    ).toMatchObject({
      statePath: "invalid",
      logPath: "invalid",
      callSocket: "invalid",
    });
  });
});
