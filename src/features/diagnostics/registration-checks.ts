import { ownsAgent } from "../../infra/setup/launchd-plan.ts";
import { splitVariables } from "../../infra/setup/open-app-plan.ts";
import type { Check } from "./doctor-report.ts";

export const legacyRegistrationCheck = (
  env: Record<string, string>,
  agent: string | null,
): Check => {
  const split = splitVariables(env);
  const owned = [
    ...split.owned,
    ...(ownsAgent(agent) ? ["the login LaunchAgent"] : []),
  ];
  const foreign = split.foreign;
  const kept =
    foreign.length > 0
      ? `; keeps ${foreign.join(", ")}, which another tool registered`
      : "";
  return owned.length > 0
    ? {
        status: "warn",
        name: "Login-wide setup",
        detail: `an earlier harnexus left ${owned.join(", ")}; run harnexus open-app --standard to clear it${kept}`,
      }
    : {
        status: "ok",
        name: "Login-wide setup",
        detail: `none; only harnexus open-app runs the app with harnexus${kept}`,
      };
};
