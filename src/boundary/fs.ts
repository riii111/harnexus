import { closeSync, fchmodSync, openSync, writeSync } from "node:fs";
import { Result, TaggedError } from "better-result";

class LogFileOpenFailed extends TaggedError("LogFileOpenFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

// The open mode applies only to a new file, so an existing one is narrowed too; a failed write is dropped because logging must never stop the relay.
export const openAppendSink = (path: string) =>
  Result.try({
    try: () => {
      const fd = openSync(path, "a", OWNER_ONLY);
      try {
        fchmodSync(fd, OWNER_ONLY);
      } catch (cause) {
        closeSync(fd);
        throw cause;
      }
      return (line: string) => {
        try {
          writeSync(fd, line);
        } catch {}
      };
    },
    catch: (cause) =>
      new LogFileOpenFailed({ path, cause, message: `cannot open ${path}` }),
  });

const OWNER_ONLY = 0o600;
