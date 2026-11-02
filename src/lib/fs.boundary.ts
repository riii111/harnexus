import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  constants,
  type Dirent,
  ftruncateSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import {
  access,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Result, TaggedError } from "better-result";
import { isObject } from "./object.ts";

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

// A sink that appends each log line to path, moving a full file aside first.
export const openLogSink = (path: string, rotateAbove = LOG_ROTATE_BYTES) =>
  Result.try({
    try: () => {
      mkdirSync(dirname(path), {
        recursive: true,
        mode: OWNER_ONLY_DIRECTORY,
      });
      if (
        (statSync(path, { throwIfNoEntry: false })?.size ?? 0) > rotateAbove
      ) {
        // Another bridge starting at the same time may have moved it first.
        try {
          renameSync(path, `${path}.1`);
        } catch {}
      }
      appendFileSync(path, "", { mode: OWNER_ONLY });
      // The mode applies only to a new file, so an existing one is narrowed too.
      chmodSync(path, OWNER_ONLY);
      return (line: string) => {
        try {
          // Each line is appended by path, so a bridge whose file another bridge moved aside at start writes to the new file, and lines of bridges running at once stay whole.
          appendFileSync(path, line, { mode: OWNER_ONLY });
          // A failed write is dropped because logging must never stop the relay.
        } catch {}
      };
    },
    catch: (cause) =>
      new LogFileOpenFailed({ path, cause, message: `cannot open ${path}` }),
  });

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

export const readRegularTextFile = (path: string) =>
  Result.tryPromise({
    try: async () => {
      // A FIFO or device would keep the read waiting forever, so only a regular file is read.
      if (!(await stat(path)).isFile()) {
        throw new Error(`${path} is not a regular file`);
      }
      return await readFile(path, "utf8");
    },
    catch: (cause) =>
      new FileReadFailed({ path, cause, message: `cannot read ${path}` }),
  });

export const readRegularFileBytesWithin = (path: string, limit: number) =>
  Result.tryPromise({
    try: async () => {
      const found = await stat(path);
      if (!found.isFile()) throw new Error(`${path} is not a regular file`);
      return found.size > limit ? null : await readFile(path);
    },
    catch: (cause) =>
      new FileReadFailed({ path, cause, message: `cannot read ${path}` }),
  });

export const statFileIfExists = (path: string) =>
  Result.tryPromise({
    try: async () => {
      try {
        const found = await stat(path);
        return found.isFile()
          ? { size: found.size, modifiedMs: Math.trunc(found.mtimeMs) }
          : null;
      } catch (cause) {
        // A file removed after its folder was listed is taken as missing.
        if (isMissingFile(cause)) return null;
        throw cause;
      }
    },
    catch: (cause) =>
      new FileReadFailed({ path, cause, message: `cannot read ${path}` }),
  });

export const readFileSlice = (path: string, start: number, length: number) =>
  Result.tryPromise({
    try: async () => {
      const file = await open(path, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, start);
        // A multibyte character cut at either end decodes as a replacement character.
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await file.close();
      }
    },
    catch: (cause) =>
      new FileReadFailed({ path, cause, message: `cannot read ${path}` }),
  });

export const writeFileAtomic = (path: string, content: string) =>
  Result.gen(async function* () {
    yield* Result.await(replaceFile(path, content));
    // A FileSyncFailed here means the file already holds the new content but the rename may not survive a crash.
    yield* Result.await(syncParent(path, "wrote"));
    return Result.ok();
  });

const replaceFile = (path: string, content: string) =>
  Result.tryPromise({
    try: async () => {
      const temporary = await writeTemporary(path, content);
      // The rename happens only after the temporary file is flushed to disk, so readers see either the previous or the new content.
      await rename(temporary, path).catch(async (cause) => {
        await rm(temporary, { force: true }).catch(() => {});
        throw cause;
      });
    },
    catch: (cause) =>
      new FileWriteFailed({ path, cause, message: `cannot write ${path}` }),
  });

export const writeFileExclusive = (path: string, content: string) =>
  Result.gen(async function* () {
    const created = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const temporary = await writeTemporary(path, content);
          try {
            // Linking fails when a file already exists at path, so of several writers only one creates it, and only with its full content.
            return await link(temporary, path).then(
              () => true,
              (cause) => {
                if (isObject(cause) && cause.code === "EEXIST") return false;
                throw cause;
              },
            );
          } finally {
            await rm(temporary, { force: true });
          }
        },
        catch: (cause) =>
          new FileWriteFailed({ path, cause, message: `cannot write ${path}` }),
      }),
    );
    if (created) yield* Result.await(syncParent(path, "wrote"));
    return Result.ok(created);
  });

const writeTemporary = async (path: string, content: string) => {
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
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => {});
    throw cause;
  }
  return temporary;
};

export const isFile = async (path: string) =>
  (await stat(path).catch(() => null))?.isFile() ?? false;

export const fileIdentity = async (path: string) => {
  const found = await stat(path).catch(() => null);
  return found?.isFile()
    ? {
        // The device and inode tell a file swapped in at the path from one changed in place.
        dev: found.dev,
        ino: found.ino,
        size: found.size,
        modifiedMs: Math.trunc(found.mtimeMs),
      }
    : null;
};

export const isDirectory = async (path: string) =>
  (await stat(path).catch(() => null))?.isDirectory() ?? false;

export const pathExists = async (path: string) =>
  (await stat(path).catch(() => null)) !== null;

export const realPathOrSelf = (path: string) =>
  realpath(resolve(path)).catch(() => resolve(path));

export const prepareDirectory = (path: string) =>
  Result.tryPromise({
    try: async () => {
      await mkdir(path, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
      // The parent is synced too, so files created inside later cannot be lost with a directory entry that never reached the disk.
      await syncDirectory(dirname(path));
    },
    catch: (cause) =>
      new DirectoryPrepareFailed({
        path,
        cause,
        message: `cannot prepare directory ${path}`,
      }),
  });

class AccessDenied extends TaggedError("AccessDenied")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export const checkAccess = (path: string, mode: "write" | "execute") =>
  Result.tryPromise({
    try: () => access(path, mode === "write" ? constants.W_OK : constants.X_OK),
    catch: (cause) =>
      new AccessDenied({
        path,
        cause,
        message: `cannot ${mode === "write" ? "write to" : "run"} ${path}`,
      }),
  });

export const listFileNames = (path: string) =>
  Result.tryPromise({
    try: () => readdir(path),
    catch: (cause) =>
      new FileReadFailed({ path, cause, message: `cannot list ${path}` }),
  });

export const listDirectoryIfExists = (path: string) =>
  Result.tryPromise({
    try: async () => {
      try {
        return await readdir(path);
      } catch (cause) {
        if (isMissingFile(cause) || isNotDirectory(cause)) return null;
        throw cause;
      }
    },
    catch: (cause) =>
      new FileReadFailed({ path, cause, message: `cannot list ${path}` }),
  });

// The regular files at any depth under a folder, as paths relative to it.
export const listFilesDeepIfExists = (path: string) =>
  Result.tryPromise({
    try: async () => {
      const top = await readEntries(path);
      if (top === null) return null;
      const files: string[] = [];
      const walk = async (
        entries: readonly Dirent[],
        prefix: readonly string[],
      ): Promise<void> => {
        for (const entry of entries) {
          if (entry.isFile()) {
            files.push(join(...prefix, entry.name));
          } else if (entry.isDirectory()) {
            const below = [...prefix, entry.name];
            // A folder that cannot be listed is passed over, as Claude's own reader passes it over.
            const nested = await readEntries(join(path, ...below)).catch(
              () => null,
            );
            if (nested !== null) await walk(nested, below);
          }
        }
      };
      await walk(top, []);
      return files;
    },
    catch: (cause) =>
      new FileReadFailed({ path, cause, message: `cannot list ${path}` }),
  });

const readEntries = async (path: string) => {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (cause) {
    if (isMissingFile(cause) || isNotDirectory(cause)) return null;
    throw cause;
  }
};

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
    // The file exists from here, so a later failure is FileSyncFailed and the caller must clean it up.
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

// Takes the lock at path for the life of the process, or answers false while another process holds it.
export const holdProcessLock = (path: string) =>
  Result.try({
    try: () => {
      try {
        // macOS takes the lock with the open itself, and the kernel drops it when the holder exits, so a crash never leaves it behind.
        const fd = openSync(path, LOCK_FLAGS, OWNER_ONLY);
        ftruncateSync(fd);
        writeSync(fd, `${process.pid}\n`);
        // The descriptor is never closed, so the lock lasts as long as the process.
        return true;
      } catch (cause) {
        if (isObject(cause) && cause.code === "EAGAIN") return false;
        throw cause;
      }
    },
    catch: (cause) =>
      new FileWriteFailed({ path, cause, message: `cannot lock ${path}` }),
  });

const O_EXLOCK = 0x20;

const LOCK_FLAGS =
  constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK;

export const removeFile = (path: string) =>
  Result.gen(async function* () {
    yield* Result.await(
      Result.tryPromise({
        try: async () => {
          try {
            await unlink(path);
          } catch (cause) {
            // A missing file counts as removed.
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
    // A FileSyncFailed here means the file is gone but may come back after a crash.
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

const isNotDirectory = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOTDIR";

const OWNER_ONLY = 0o600;

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

const OWNER_ONLY_DIRECTORY = 0o700;
