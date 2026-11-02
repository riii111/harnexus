import { launchAgent } from "../infra/setup/launchd-plan.ts";
import { REGISTERED_ENV_NAMES } from "../infra/setup/open-app-plan.ts";
import type { Check } from "./doctor-report.ts";

export const registrationChecks = (
  expected: Record<string, string>,
  actual: Record<string, string>,
  agent: string | null,
): Check[] => {
  const present = REGISTERED_ENV_NAMES.filter(
    (name) => actual[name] !== undefined,
  );
  const mismatched = REGISTERED_ENV_NAMES.filter(
    (name) => expected[name] !== actual[name],
  );
  return [
    {
      name: "launchd environment",
      status: present.length === 0 || mismatched.length > 0 ? "warn" : "ok",
      detail:
        present.length === 0
          ? "not registered; run bun run open-app"
          : mismatched.length > 0
            ? `values differ from this checkout/shell: ${mismatched.join(", ")}`
            : "registered; values match this checkout/shell",
    },
    {
      name: "Login LaunchAgent",
      status: agent === launchAgent(expected) ? "ok" : "warn",
      detail:
        agent === null
          ? "not installed"
          : agent === launchAgent(expected)
            ? "installed; restores this setup at login"
            : "installed; contents differ from this checkout/shell",
    },
  ];
};
