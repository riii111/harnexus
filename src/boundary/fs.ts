import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, openSync, writeSync } from "node:fs";
import {
  access,
  constants,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Result, TaggedError } from "better-result";

export class FileNotExecutable extends TaggedError("FileNotExecutable")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

class LogFileOpenFailed extends TaggedError("LogFileOpenFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

class FileReadFailed extends TaggedError("FileReadFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export class FileWriteFailed extends TaggedError("FileWriteFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export class FileSyncFailed extends TaggedError("FileSyncFailed")<{
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

// A missing file is not an error, so a first start can begin from an empty state.
export const readTextFileIfExists = (path: string) =>
  Result.tryPromise({
    try: async () => {
      try {
        return await readFile(path, "utf8");
      } catch (cause) {
        if (isMissingFile(cause)) return null;
        throw cause;
      }
    },
    catch: (cause) =>
      new FileReadFailed({ path, cause, message: `cannot read ${path}` }),
  });

// FileSyncFailed means the file already holds the new content but the rename may not survive a crash.
export const writeFileAtomic = (path: string, content: string) =>
  Result.gen(async function* () {
    yield* Result.await(replaceFile(path, content));
    yield* Result.await(
      Result.tryPromise({
        try: () => syncDirectory(dirname(path)),
        catch: (cause) =>
          new FileSyncFailed({
            path,
            cause,
            message: `wrote ${path} but cannot sync its directory`,
          }),
      }),
    );
    return Result.ok();
  });

// Readers see either the previous or the new content, because the rename happens only after the temporary file is flushed to disk.
const replaceFile = (path: string, content: string) =>
  Result.tryPromise({
    try: async () => {
      const temporary = join(
        dirname(path),
        `.${basename(path)}.${randomUUID()}.tmp`,
      );
      try {
        const file = await open(temporary, "wx", OWNER_ONLY);
        try {
          await file.writeFile(content, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      } catch (cause) {
        await rm(temporary, { force: true }).catch(() => {});
        throw cause;
      }
    },
    catch: (cause) =>
      new FileWriteFailed({ path, cause, message: `cannot write ${path}` }),
  });

const syncDirectory = async (path: string) => {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

const isMissingFile = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const OWNER_ONLY = 0o600;
