import { describe, expect, test } from "bun:test";

import { launchAgent } from "../infra/setup/launchd-plan.ts";
import { registrationChecks } from "./registration-checks.ts";

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
