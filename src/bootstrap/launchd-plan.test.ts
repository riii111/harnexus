import { describe, expect, test } from "bun:test";
import {
  environmentCommands,
  launchAgent,
  registrationChecks,
} from "./launchd-plan.ts";
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

describe("registrationChecks", () => {
  test("reports matching registration and login restoration", () => {
    expect(
      registrationChecks(ENV, ENV, launchAgent(ENV)).map(
        ({ status }) => status,
      ),
    ).toEqual(["ok", "ok"]);
  });
  test("reports absent registration", () => {
    expect(registrationChecks(ENV, {}, null)).toMatchObject([
      { status: "warn", detail: "not registered; run bun run open-app" },
      { status: "warn", detail: "not installed" },
    ]);
  });
  test("names mismatched variables without exposing their values", () => {
    const checks = registrationChecks(
      ENV,
      { ...ENV, HARNEXUS_UNVERIFIED_CODEX: "private-value" },
      launchAgent({ ...ENV, HARNEXUS_UNVERIFIED_CODEX: "private-value" }),
    );
    expect(checks[0]).toMatchObject({
      status: "warn",
      detail:
        "values differ from this checkout/shell: HARNEXUS_UNVERIFIED_CODEX",
    });
    expect(checks[1]?.status).toBe("warn");
    expect(JSON.stringify(checks)).not.toContain("private-value");
  });
});

const ENV = {
  CODEX_CLI_PATH: "/launcher",
  HARNEXUS_CODEX_PATH: "/codex",
  HARNEXUS_BUN_PATH: "/bun",
};
