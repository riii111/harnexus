import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Result, TaggedError } from "better-result";

class LogPathNotAbsolute extends TaggedError("LogPathNotAbsolute")<{
  path: string;
  message: string;
}> {}

class StatePathNotAbsolute extends TaggedError("StatePathNotAbsolute")<{
  path: string;
  message: string;
}> {}

const LOG_PATH_ENV = "HARNEXUS_LOG_PATH";

export const loadLogPath = (env: Record<string, string | undefined>) => {
  const path = env[LOG_PATH_ENV];
  if (path === undefined || path === "") return Result.ok(null);
  if (!isAbsolute(path)) {
    return Result.err(
      new LogPathNotAbsolute({
        path,
        message: `${LOG_PATH_ENV} must be an absolute path`,
      }),
    );
  }
  return Result.ok(path);
};

const STATE_PATH_ENV = "HARNEXUS_STATE_PATH";

export const loadStatePath = (
  env: Record<string, string | undefined>,
  home: () => string = homedir,
) => {
  const path = env[STATE_PATH_ENV];
  if (path === undefined || path === "") {
    return Result.ok(join(home(), DEFAULT_STATE_PATH));
  }
  if (!isAbsolute(path)) {
    return Result.err(
      new StatePathNotAbsolute({
        path,
        message: `${STATE_PATH_ENV} must be an absolute path`,
      }),
    );
  }
  return Result.ok(path);
};

class ConnectionsPathNotAbsolute extends TaggedError(
  "ConnectionsPathNotAbsolute",
)<{
  path: string;
  message: string;
}> {}

const CONNECTIONS_PATH_ENV = "HARNEXUS_CONNECTIONS_PATH";

export const loadConnectionsPath = (
  env: Record<string, string | undefined>,
  home: () => string = homedir,
) => {
  const path = env[CONNECTIONS_PATH_ENV];
  if (path === undefined || path === "") {
    return Result.ok(join(home(), DEFAULT_CONNECTIONS_PATH));
  }
  if (!isAbsolute(path)) {
    return Result.err(
      new ConnectionsPathNotAbsolute({
        path,
        message: `${CONNECTIONS_PATH_ENV} must be an absolute path`,
      }),
    );
  }
  return Result.ok(path);
};

const SHUTDOWN_GRACE_ENV = "HARNEXUS_SHUTDOWN_GRACE_MS";

export const loadShutdownGraceMs = (
  env: Record<string, string | undefined>,
) => {
  const value = Number(env[SHUTDOWN_GRACE_ENV]);
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_SHUTDOWN_GRACE_MS;
};

const UNVERIFIED_CODEX_ENV = "HARNEXUS_UNVERIFIED_CODEX";

// "pause" keeps Claude threads from running on a Codex CLI the bridge was not checked on; anything else only warns.
export const loadUnverifiedCodexPolicy = (
  env: Record<string, string | undefined>,
): "warn" | "pause" =>
  env[UNVERIFIED_CODEX_ENV] === "pause" ? "pause" : "warn";

const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

const DEFAULT_STATE_PATH = ".local/state/harnexus/threads.json";

const DEFAULT_CONNECTIONS_PATH = ".config/harnexus/connections.json";
