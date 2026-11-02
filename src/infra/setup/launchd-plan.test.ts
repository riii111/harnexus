import { describe, expect, test } from "bun:test";
import { environmentCommands, launchAgent } from "./launchd-plan.ts";
import { registeredEnvironment } from "./open-app-plan.ts";

describe("environmentCommands", () => {
  test("clears stale optional settings and accepts only registered variable names", () => {
    const commands = environmentCommands({
      CODEX_CLI_PATH: "/work/launcher",
      ANTHROPIC_API_KEY: "secret",
    });
    expect(commands).toContainEqual([
      "setenv",
      "CODEX_CLI_PATH",
      "/work/launcher",
    ]);
    expect(commands).toContainEqual(["unsetenv", "HARNEXUS_PERMISSION_MODE"]);
    expect(commands.flat()).not.toContain("secret");
  });
  test("unsets every owned variable when returning to standard", () => {
    expect(environmentCommands({})).toEqual([
      ["unsetenv", "CODEX_CLI_PATH"],
      ["unsetenv", "HARNEXUS_CODEX_PATH"],
      ["unsetenv", "HARNEXUS_BUN_PATH"],
      ["unsetenv", "HARNEXUS_LOG_PATH"],
      ["unsetenv", "HARNEXUS_STATE_PATH"],
      ["unsetenv", "HARNEXUS_UNVERIFIED_CODEX"],
      ["unsetenv", "HARNEXUS_PERMISSION_MODE"],
      ["unsetenv", "HARNEXUS_CALL_SOCKET"],
    ]);
  });
});

describe("launchAgent", () => {
  test("quotes paths for both shell and XML without saving credentials", () => {
    const env = registeredEnvironment(
      {
        app: "/app",
        launcher: "/a'b & <c>/$(touch nope)",
        codex: "/codex",
        bun: "/bun",
      },
      { ANTHROPIC_API_KEY: "secret", HARNEXUS_PERMISSION_MODE: "auto" },
    );
    const plist = launchAgent(env);
    expect(plist).toContain(
      "/a&apos;\\&apos;&apos;b &amp; &lt;c&gt;/$(touch nope)",
    );
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).not.toContain("secret");
  });
});
