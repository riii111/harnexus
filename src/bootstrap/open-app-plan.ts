import type { ProcessEntry } from "./doctor-report.ts";

type OpenAppPaths = {
  app: string;
  launcher: string;
  codex: string;
  bun: string;
};

export const registeredEnvironment = (
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
    : Object.entries(registeredEnvironment(paths, env)).flatMap(
        ([key, value]) => ["--env", `${key}=${value}`],
      )),
];

export const REGISTERED_ENV_NAMES = [
  "CODEX_CLI_PATH",
  "HARNEXUS_CODEX_PATH",
  "HARNEXUS_BUN_PATH",
  "HARNEXUS_LOG_PATH",
  "HARNEXUS_STATE_PATH",
  "HARNEXUS_UNVERIFIED_CODEX",
  "HARNEXUS_PERMISSION_MODE",
  "HARNEXUS_CALL_SOCKET",
] as const;

// The environment reaches the app only when it starts, so a running app keeps the setup it was opened with.
export const isAppRunning = (
  processes: readonly ProcessEntry[],
  app: string,
) => {
  const binary = `${app}/Contents/MacOS/`;
  return processes.some(({ command }) => command.startsWith(binary));
};

const PASSED_ENV = REGISTERED_ENV_NAMES.slice(3);
