import { basename } from "node:path";

import { APP_ENV_NAMES } from "./open-app-plan.ts";

// Earlier versions registered the app's environment for the whole login session under this label, so it is only ever cleared now.
export const AGENT_LABEL = "com.harnexus.environment";

// Another tool may point CODEX_CLI_PATH at its own launcher, so only a value naming this launcher counts as harnexus's.
export const ownedVariables = (env: Record<string, string | undefined>) =>
  APP_ENV_NAMES.filter(
    (name) =>
      env[name] !== undefined &&
      (name !== "CODEX_CLI_PATH" || basename(env[name]) === LAUNCHER_FILE),
  );

export const foreignVariables = (env: Record<string, string | undefined>) => {
  const owned = ownedVariables(env);
  return APP_ENV_NAMES.filter(
    (name) => env[name] !== undefined && !owned.includes(name),
  );
};

export const ownsAgent = (agent: string | null) =>
  agent?.includes(`<key>Label</key><string>${AGENT_LABEL}</string>`) ?? false;

const LAUNCHER_FILE = "harnexus-codex";
