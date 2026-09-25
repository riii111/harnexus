import { isAbsolute } from "node:path";
import { Result, TaggedError } from "better-result";

class LogPathNotAbsolute extends TaggedError("LogPathNotAbsolute")<{
  path: string;
  message: string;
}> {}

export const LOG_PATH_ENV = "HARNEXUS_LOG_PATH";

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

export const SHUTDOWN_GRACE_ENV = "HARNEXUS_SHUTDOWN_GRACE_MS";

export const loadShutdownGraceMs = (
  env: Record<string, string | undefined>,
) => {
  const value = Number(env[SHUTDOWN_GRACE_ENV]);
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_SHUTDOWN_GRACE_MS;
};

const DEFAULT_SHUTDOWN_GRACE_MS = 5000;
