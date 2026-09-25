import { openSync, writeSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { Result, TaggedError } from "better-result";

export class FileNotExecutable extends TaggedError("FileNotExecutable")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export class LogFileOpenFailed extends TaggedError("LogFileOpenFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export const checkExecutable = (path: string) =>
  Result.tryPromise({
    try: () => access(path, constants.X_OK),
    catch: (cause) =>
      new FileNotExecutable({
        path,
        cause,
        message: `${path} is not an executable file`,
      }),
  });

// A new file is readable only by the owner; a failed write is dropped because logging must never stop the relay.
export const openAppendSink = (path: string) =>
  Result.try({
    try: () => {
      const fd = openSync(path, "a", 0o600);
      return (line: string) => {
        try {
          writeSync(fd, line);
        } catch {}
      };
    },
    catch: (cause) =>
      new LogFileOpenFailed({ path, cause, message: `cannot open ${path}` }),
  });
