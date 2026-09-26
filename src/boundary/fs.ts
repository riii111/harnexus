import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, openSync, writeSync } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Result, TaggedError } from "better-result";

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

export class FileRemoveFailed extends TaggedError("FileRemoveFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

class DirectoryPrepareFailed extends TaggedError("DirectoryPrepareFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

// The open mode applies only to a new file, so an existing one is narrowed too; a failed write is dropped because logging must never stop the relay.
export const openLogSink = (path: string) =>
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
    yield* Result.await(syncParent(path, "wrote"));
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

// The parent is synced too, so files created inside later cannot be lost with a directory entry that never reached the disk.
export const prepareDirectory = (path: string) =>
  Result.tryPromise({
    try: async () => {
      await mkdir(path, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
      await syncDirectory(dirname(path));
    },
    catch: (cause) =>
      new DirectoryPrepareFailed({
        path,
        cause,
        message: `cannot prepare directory ${path}`,
      }),
  });

export const listFileNames = (path: string) =>
  Result.tryPromise({
    try: () => readdir(path),
    catch: (cause) =>
      new FileReadFailed({ path, cause, message: `cannot list ${path}` }),
  });

// A missing directory is null rather than an error, since it means there is nothing in it.
export const listDirectoryIfExists = (path: string) =>
  Result.tryPromise({
    try: async () => {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }));
      } catch (cause) {
        if (isMissingFile(cause)) return null;
        throw cause;
      }
    },
    catch: (cause) =>
      new FileReadFailed({ path, cause, message: `cannot list ${path}` }),
  });

// Only a failed open means nothing was created; any later failure is FileSyncFailed, because the file already exists and must be cleaned up by the caller.
export const createEmptyFile = (path: string) =>
  Result.gen(async function* () {
    const file = yield* Result.await(
      Result.tryPromise({
        try: () => open(path, "wx", OWNER_ONLY),
        catch: (cause) =>
          new FileWriteFailed({
            path,
            cause,
            message: `cannot create ${path}`,
          }),
      }),
    );
    yield* Result.await(
      Result.tryPromise({
        try: async () => {
          try {
            await file.sync();
          } finally {
            await file.close();
          }
          await syncDirectory(dirname(path));
        },
        catch: (cause) =>
          new FileSyncFailed({
            path,
            cause,
            message: `created ${path} but cannot sync it`,
          }),
      }),
    );
    return Result.ok();
  });

// FileSyncFailed means the file is gone but may come back after a crash; a missing file counts as removed.
export const removeFile = (path: string) =>
  Result.gen(async function* () {
    yield* Result.await(
      Result.tryPromise({
        try: async () => {
          try {
            await unlink(path);
          } catch (cause) {
            if (!isMissingFile(cause)) throw cause;
          }
        },
        catch: (cause) =>
          new FileRemoveFailed({
            path,
            cause,
            message: `cannot remove ${path}`,
          }),
      }),
    );
    yield* Result.await(syncParent(path, "removed"));
    return Result.ok();
  });

const syncParent = (path: string, action: string) =>
  Result.tryPromise({
    try: () => syncDirectory(dirname(path)),
    catch: (cause) =>
      new FileSyncFailed({
        path,
        cause,
        message: `${action} ${path} but cannot sync its directory`,
      }),
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

const OWNER_ONLY_DIRECTORY = 0o700;
