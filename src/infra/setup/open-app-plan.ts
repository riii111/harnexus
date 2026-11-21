import { basename } from "node:path";

type OpenAppPaths = {
  app: string;
  launcher: string;
  codex: string;
  bun: string;
};

export const appEnvironment = (
  paths: OpenAppPaths,
  env: Record<string, string | undefined>,
): Record<string, string> => ({
  CODEX_CLI_PATH: paths.launcher,
  HARNEXUS_CODEX_PATH: paths.codex,
  HARNEXUS_BUN_PATH: paths.bun,
  ...Object.fromEntries(
    PASSED_ENV.flatMap((name) => {
      const value = env[name];
      return value === undefined || value === "" ? [] : [[name, value]];
    }),
  ),
});

export const openArguments = (
  paths: OpenAppPaths,
  mode: "harnexus" | "standard",
  env: Record<string, string | undefined>,
) => [
  "-a",
  paths.app,
  ...(mode === "standard"
    ? []
    : Object.entries(appEnvironment(paths, env)).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ])),
];

export const APP_ENV_NAMES = [
  "CODEX_CLI_PATH",
  "HARNEXUS_CODEX_PATH",
  "HARNEXUS_BUN_PATH",
  "HARNEXUS_LOG_PATH",
  "HARNEXUS_STATE_PATH",
  "HARNEXUS_UNVERIFIED_CODEX",
  "HARNEXUS_PERMISSION_MODE",
  "HARNEXUS_CALL_SOCKET",
] as const;

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

// open hands its own environment to the app, so a standard launch from a shell that ran harnexus would still go through the launcher.
export const openEnvironment = (
  mode: "harnexus" | "standard",
  env: Record<string, string | undefined>,
) => {
  if (mode === "harnexus") return env;
  const owned: readonly string[] = ownedVariables(env);
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !owned.includes(name)),
  );
};

export const isAppRunning = <T extends { command: string }>(
  processes: readonly T[],
  app: string,
) => {
  const binary = `${app}/Contents/MacOS/`;
  return processes.some(({ command }) => command.startsWith(binary));
};

const PASSED_ENV = APP_ENV_NAMES.slice(3);
const LAUNCHER_FILE = "harnexus-codex";
