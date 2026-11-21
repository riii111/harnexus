import {
  foreignVariables,
  ownedVariables,
  ownsAgent,
} from "../../infra/setup/launchd-plan.ts";
import type { Check } from "./doctor-report.ts";

export const legacyRegistrationCheck = (
  env: Record<string, string>,
  agent: string | null,
): Check => {
  const owned = [
    ...ownedVariables(env),
    ...(ownsAgent(agent) ? ["the login LaunchAgent"] : []),
  ];
  const foreign = foreignVariables(env);
  const kept =
    foreign.length > 0
      ? `; keeps ${foreign.join(", ")}, which another tool registered`
      : "";
  return owned.length > 0
    ? {
        status: "warn",
        name: "Login-wide setup",
        detail: `an earlier harnexus left ${owned.join(", ")}, so a launch from the Dock also runs harnexus; run harnexus open-app --standard to clear it${kept}`,
      }
    : {
        status: "ok",
        name: "Login-wide setup",
        detail: `none; only harnexus open-app runs the app with harnexus${kept}`,
      };
};
