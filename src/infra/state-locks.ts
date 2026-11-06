import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Result, TaggedError } from "better-result";
import { z } from "zod";

import {
  listDirectoryIfExists,
  prepareDirectory,
  readTextFileIfExists,
  removeFile,
  writeFileAtomic,
  writeFileExclusive,
} from "../lib/fs.boundary.ts";
import { parseJson } from "../lib/json.boundary.ts";
import { isProcessAlive } from "../lib/process.boundary.ts";

// Each lock and presence names the process that holds it; a file whose process has exited is stale, and a socket that does not answer is never taken for an exited bridge.
const OWNER = z.strictObject({
  pid: z.number().int().positive(),
  token: z.string().min(1),
  startedAt: z.string(),
});

type Owner = z.infer<typeof OWNER>;

export type LockDeps = {
  pid: number;
  alive: (pid: number) => boolean;
  newToken: () => string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
};

export const LOCK_DEPS: LockDeps = {
  pid: process.pid,
  alive: isProcessAlive,
  newToken: randomUUID,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class MaintenanceRunning extends TaggedError("MaintenanceRunning")<{
  pid: number;
  message: string;
}> {}

export class BridgesRunning extends TaggedError("BridgesRunning")<{
  pids: readonly number[];
  message: string;
}> {}

export class StateLockBusy extends TaggedError("StateLockBusy")<{
  path: string;
  pid: number;
  message: string;
}> {}

export class StateLockFailed extends TaggedError("StateLockFailed")<{
  path: string;
  cause?: unknown;
  message: string;
}> {}

const failed = (path: string) => (cause: unknown) =>
  new StateLockFailed({ path, cause, message: `cannot use ${path}` });

const ownerOf = (deps: LockDeps): Owner => ({
  pid: deps.pid,
  token: deps.newToken(),
  startedAt: deps.now().toISOString(),
});

const readOwner = (path: string) =>
  Result.gen(async function* () {
    const text = yield* Result.await(
      readTextFileIfExists(path).then((read) => read.mapError(failed(path))),
    );
    if (text === null) return Result.ok(null);
    const parsed = OWNER.safeParse(parseJson(text).unwrapOr(null));
    // Only these files write the lock, and each writes it whole, so one that does not parse was written by hand and is left for the user.
    return parsed.success
      ? Result.ok(parsed.data)
      : Result.err(
          new StateLockFailed({
            path,
            message: `${path} is not a lock this version writes; remove it once nothing uses the state`,
          }),
        );
  });

// Takes the lock at path, waiting up to waitMs while a live process holds it; a lock whose process exited is taken over.
export const acquireLock = (
  path: string,
  waitMs: number,
  deps: LockDeps = LOCK_DEPS,
) =>
  Result.gen(async function* () {
    const owner = ownerOf(deps);
    const deadline = deps.now().getTime() + waitMs;
    for (;;) {
      const created = yield* Result.await(
        writeFileExclusive(path, JSON.stringify(owner)).then((made) =>
          made.mapError(failed(path)),
        ),
      );
      if (created)
        return Result.ok({ release: () => releaseLock(path, owner) });
      const holder = yield* Result.await(readOwner(path));
      if (holder === null) continue;
      if (!deps.alive(holder.pid)) {
        yield* Result.await(takeOver(path, holder, owner, deps));
        continue;
      }

      if (deps.now().getTime() >= deadline)
        return Result.err(
          new StateLockBusy({
            path,
            pid: holder.pid,
            message: `${path} is held by process ${holder.pid}`,
          }),
        );
      await deps.sleep(LOCK_RETRY_MS);
    }
  });

// Removes the lock only while it still names the exited holder; the takeover file keeps two processes from removing a lock another has just taken.
const takeOver = (path: string, stale: Owner, owner: Owner, deps: LockDeps) =>
  Result.gen(async function* () {
    const guard = `${path}.takeover`;
    const guarded = yield* Result.await(
      writeFileExclusive(guard, JSON.stringify(owner)).then((made) =>
        made.mapError(failed(guard)),
      ),
    );
    if (!guarded) {
      const taker = yield* Result.await(readOwner(guard));
      if (taker !== null && !deps.alive(taker.pid))
        return Result.err(
          new StateLockFailed({
            path: guard,
            message: `process ${taker.pid} exited while taking over ${path}; remove ${guard} once nothing uses the state`,
          }),
        );
      await deps.sleep(LOCK_RETRY_MS);
      return Result.ok();
    }

    try {
      const holder = yield* Result.await(readOwner(path));
      if (holder?.token === stale.token)
        yield* Result.await(
          removeFile(path).then((removed) => removed.mapError(failed(path))),
        );
    } finally {
      await removeFile(guard);
    }

    return Result.ok();
  });

const releaseLock = async (path: string, owner: Owner) => {
  const holder = await readOwner(path);
  if (holder.isOk() && holder.value?.token === owner.token)
    await removeFile(path);
};

const LOCK_RETRY_MS = 20;

// Offline state operations and bridges keep apart through files beside the thread state: one presence per running bridge and one maintenance lock.
// A bridge writes its presence before it reads the lock, and an operation takes the lock before it reads the presences, so of a bridge and an operation starting at once at least one sees the other and stops.
const MAINTENANCE_LOCK = "maintenance.lock";
const BRIDGES_FOLDER = "bridges";

// Registers a starting bridge, or answers that an offline operation holds the state; the caller removes the presence when the bridge exits.
export const enterAsBridge = (stateDir: string, deps: LockDeps = LOCK_DEPS) =>
  Result.gen(async function* () {
    const folder = join(stateDir, BRIDGES_FOLDER);
    yield* Result.await(
      prepareDirectory(folder).then((made) => made.mapError(failed(folder))),
    );
    const owner = ownerOf(deps);
    const presence = join(folder, `${owner.pid}-${owner.token}.json`);
    yield* Result.await(
      writeFileAtomic(presence, JSON.stringify(owner)).then((written) =>
        written.mapError(failed(presence)),
      ),
    );
    const holder = await readOwner(join(stateDir, MAINTENANCE_LOCK));
    // A lock that cannot be read may be a live operation's, so the bridge stays out as it would for one.
    const blocking = holder.isErr()
      ? 0
      : holder.value !== null && deps.alive(holder.value.pid)
        ? holder.value.pid
        : null;
    if (blocking !== null) {
      await removeFile(presence);
      return Result.err(
        new MaintenanceRunning({
          pid: blocking,
          message:
            blocking === 0
              ? `${join(stateDir, MAINTENANCE_LOCK)} cannot be read`
              : `process ${blocking} is changing the state offline`,
        }),
      );
    }

    return Result.ok({ presence });
  });

// Takes the maintenance lock for an offline operation, refusing while another operation or any bridge is alive.
export const enterMaintenance = async (
  stateDir: string,
  deps: LockDeps = LOCK_DEPS,
): Promise<
  Result<
    { release: () => Promise<void> },
    MaintenanceRunning | BridgesRunning | StateLockFailed
  >
> => {
  const lock = await acquireLock(join(stateDir, MAINTENANCE_LOCK), 0, deps);
  if (lock.isErr())
    return Result.err(
      lock.error._tag === "StateLockBusy"
        ? new MaintenanceRunning({
            pid: lock.error.pid,
            message: `process ${lock.error.pid} is already changing the state offline`,
          })
        : lock.error,
    );
  const { release } = lock.value;
  const running = await liveBridges(join(stateDir, BRIDGES_FOLDER), deps);
  if (running.isErr() || running.value.length > 0) {
    await release();
    return Result.err(
      running.isErr()
        ? running.error
        : new BridgesRunning({
            pids: running.value,
            message: `harnexus bridges are running (process ${running.value.join(", ")}); quit the app and stop every program that uses Harnexus first`,
          }),
    );
  }

  return Result.ok({ release });
};

const liveBridges = (folder: string, deps: LockDeps) =>
  Result.gen(async function* () {
    const names = yield* Result.await(
      listDirectoryIfExists(folder).then((listed) =>
        listed.mapError(failed(folder)),
      ),
    );
    const live: number[] = [];
    for (const name of names ?? []) {
      if (!name.endsWith(".json")) continue;
      const path = join(folder, name);
      const owner = yield* Result.await(readOwner(path));
      if (owner === null) continue;
      if (deps.alive(owner.pid)) live.push(owner.pid);
      // A presence left by a bridge that exited without removing it.
      else await removeFile(path);
    }

    return Result.ok(live.sort((a, b) => a - b));
  });
