import { randomUUID } from "node:crypto";
import { Result } from "better-result";
import { removeFile, writeFileExclusive } from "../runtime/fs.boundary.ts";
import { type Fields, isObject } from "../runtime/object.ts";
import { processAlive } from "../runtime/run.boundary.ts";
import { fail } from "./format.ts";
import { load } from "./records.ts";
import { type Env, io } from "./request.ts";

export const configuredBinary = (env: Env, name: string, fallback: string) => {
  const configured = env[name];
  if (configured === undefined || configured === "") return Result.ok(fallback);
  return configured.startsWith("/")
    ? Result.ok(configured)
    : fail(`${name} must be an absolute path`);
};

export const milliseconds = (env: Env, name: string, fallback: number) => {
  const value = env[name];
  if (value === undefined || value === "") return Result.ok(fallback);
  return /^[1-9][0-9]{0,9}$/.test(value)
    ? Result.ok(Number(value))
    : fail(`${name} must be a positive number of milliseconds`);
};

const heldBy = async (path: string) => {
  const held = await load(path);
  return held.isOk() && isObject(held.value) ? held.value : null;
};

const dead = (holder: Fields | null) =>
  typeof holder?.pid === "number" && !processAlive(holder.pid);

// Takes the lock over from a dead holder.
const reap = (lock: string, observed: string) =>
  Result.gen(async function* () {
    // A second exclusive file guards the takeover, so of several runs only one removes the lock, and only the one it saw.
    const guard = `${lock}.reap`;
    const made = yield* Result.await(
      io(writeFileExclusive(guard, JSON.stringify({ pid: process.pid }))),
    );
    if (!made) {
      // A reaper that died leaves its guard behind; that alone is cleared.
      if (dead(await heldBy(guard))) yield* Result.await(io(removeFile(guard)));
      return Result.ok(false);
    }
    const now = await heldBy(lock);
    const same = now !== null && now.token === observed && dead(now);
    if (same) yield* Result.await(io(removeFile(lock)));
    yield* Result.await(io(removeFile(guard)));
    return Result.ok(same);
  });

// Takes the run's lock, failing at once instead of waiting.
export const acquire = (lock: string, holder: string) =>
  Result.gen(async function* () {
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const created = yield* Result.await(
        io(
          writeFileExclusive(
            lock,
            JSON.stringify({
              pid: process.pid,
              token,
              startedAt: new Date().toISOString(),
            }),
          ),
        ),
      );
      if (created) return Result.ok(token);
      const held = await heldBy(lock);
      if (held === null || !dead(held))
        return fail(
          `another ${holder}${typeof held?.pid === "number" ? ` (pid ${held.pid})` : ""} is using this session`,
        );
      const taken = yield* Result.await(reap(lock, String(held.token)));
      if (!taken) return fail(`another ${holder} is taking over this session`);
    }
    return fail(`cannot take ${lock}`);
  });

export const release = async (lock: string, token: string) => {
  const holder = await heldBy(lock);
  // Only the lock this run took goes, so a lock another run holds now stays.
  if (holder?.token === token) await removeFile(lock);
};
