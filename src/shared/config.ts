import { isAbsolute } from "node:path";
import { Result, TaggedError } from "better-result";
import { checkExecutable } from "../boundary/fs.ts";

export class CodexPathMissing extends TaggedError("CodexPathMissing")<{
  message: string;
}> {}

export class CodexPathNotAbsolute extends TaggedError("CodexPathNotAbsolute")<{
  path: string;
  message: string;
}> {}

class LogPathNotAbsolute extends TaggedError("LogPathNotAbsolute")<{
  path: string;
  message: string;
}> {}

export const CODEX_PATH_ENV = "HARNEXUS_CODEX_PATH";
export const LOG_PATH_ENV = "HARNEXUS_LOG_PATH";

export const loadCodexPath = (env: Record<string, string | undefined>) =>
  Result.gen(async function* () {
    const path = env[CODEX_PATH_ENV];
    if (path === undefined || path === "") {
      return Result.err(
        new CodexPathMissing({ message: `${CODEX_PATH_ENV} is not set` }),
      );
    }
    if (!isAbsolute(path)) {
      return Result.err(
        new CodexPathNotAbsolute({
          path,
          message: `${CODEX_PATH_ENV} must be an absolute path`,
        }),
      );
    }
    yield* Result.await(checkExecutable(path));
    return Result.ok(path);
  });

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
