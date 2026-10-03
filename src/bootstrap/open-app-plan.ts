import type { ProcessEntry } from "./doctor-report.ts";

export type OpenAppPaths = {
  app: string;
  launcher: string;
  codex: string;
  bun: string;
};

// An app opened with harnexus takes the launcher as its Codex CLI; the log, state and connection settings paths of this shell pass through so a setup can keep its own files.
export const openArguments = (
  paths: OpenAppPaths,
  mode: "harnexus" | "standard",
  env: Record<string, string | undefined>,
) => {
  if (mode === "standard") return ["-a", paths.app];
  const passed = PASSED_ENV.flatMap((name) => {
    const value = env[name];
    return value === undefined || value === "" ? [] : [`${name}=${value}`];
  });
  return [
    "-a",
    paths.app,
    ...[
      `CODEX_CLI_PATH=${paths.launcher}`,
      `HARNEXUS_CODEX_PATH=${paths.codex}`,
      `HARNEXUS_BUN_PATH=${paths.bun}`,
      ...passed,
    ].flatMap((variable) => ["--env", variable]),
  ];
};

// The environment reaches the app only when it starts, so a running app keeps the setup it was opened with.
export const isAppRunning = (
  processes: readonly ProcessEntry[],
  app: string,
) => {
  const binary = `${app}/Contents/MacOS/`;
  return processes.some(({ command }) => command.startsWith(binary));
};

const PASSED_ENV = [
  "HARNEXUS_LOG_PATH",
  "HARNEXUS_STATE_PATH",
  "HARNEXUS_CONNECTIONS_PATH",
  "HARNEXUS_UNVERIFIED_CODEX",
];
