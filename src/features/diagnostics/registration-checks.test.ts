import { describe, expect, test } from "bun:test";

import { legacyRegistrationCheck } from "./registration-checks.ts";

describe("legacyRegistrationCheck", () => {
  test("reports nothing left when launchd holds no harnexus setup", () => {
    expect(legacyRegistrationCheck({}, null)).toMatchObject({
      status: "ok",
      detail: "none; only harnexus open-app runs the app with harnexus",
    });
  });

  test("names what an earlier harnexus left without exposing values", () => {
    const check = legacyRegistrationCheck(
      { ...LEGACY_ENV, HARNEXUS_UNVERIFIED_CODEX: "private-value" },
      AGENT,
    );

    expect(check.status).toBe("warn");
    expect(check.detail).toContain(
      "left CODEX_CLI_PATH, HARNEXUS_CODEX_PATH, HARNEXUS_UNVERIFIED_CODEX, the login LaunchAgent",
    );
    expect(check.detail).not.toContain("private-value");
  });

  test("keeps a Codex CLI path another tool registered out of the warning", () => {
    const check = legacyRegistrationCheck(
      { CODEX_CLI_PATH: "/opt/other/bin/codex-wrapper" },
      null,
    );

    expect(check).toMatchObject({
      status: "ok",
      detail:
        "none; only harnexus open-app runs the app with harnexus; keeps CODEX_CLI_PATH, which another tool registered",
    });
  });
});

const LEGACY_ENV = {
  CODEX_CLI_PATH: "/work/harnexus/bin/harnexus-codex",
  HARNEXUS_CODEX_PATH: "/codex",
};

const AGENT =
  "<plist><dict><key>Label</key><string>com.harnexus.environment</string></dict></plist>";
