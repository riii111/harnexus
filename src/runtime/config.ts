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

const SHUTDOWN_GRACE_ENV = "HARNEXUS_SHUTDOWN_GRACE_MS";

export const loadShutdownGraceMs = (
  env: Record<string, string | undefined>,
) => {
  const value = Number(env[SHUTDOWN_GRACE_ENV]);
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_SHUTDOWN_GRACE_MS;
};

const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

const DEFAULT_STATE_PATH = ".local/state/harnexus/threads.json";
