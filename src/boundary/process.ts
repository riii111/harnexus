import { type ChildProcessByStdio, spawn } from "node:child_process";
import { constants } from "node:os";
import type { Readable, Writable } from "node:stream";
import { Result, TaggedError } from "better-result";

export type Signals = NodeJS.Signals;

export type ChildExit =
  | { code: number; signal: null }
  | { code: null; signal: Signals };

export type PipedChild = ChildProcessByStdio<Writable, Readable, null>;

class ChildSpawnFailed extends TaggedError("ChildSpawnFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// Resolves once the process is running, since a missing or non-executable path is reported asynchronously through "error".
export const startChild = (
  path: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) =>
  new Promise<Result<PipedChild, ChildSpawnFailed>>((resolve) => {
    const spawned = Result.try({
      try: () => spawn(path, args, { stdio: ["pipe", "pipe", "inherit"], env }),
      catch: (cause) => spawnFailed(path, cause),
    });
    if (spawned.isErr()) {
      resolve(Result.err(spawned.error));
      return;
    }
    const child = spawned.value;
    const onError = (cause: unknown) => {
      resolve(Result.err(spawnFailed(path, cause)));
    };
    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      // After start, "error" only reports a failed kill, and callers wait for the exit that follows instead.
      child.on("error", () => {});
      resolve(Result.ok(child));
    });
  });

// Re-raising lets the caller tell a signal from an exit code; process.exit is reached only when the signal is ignored.
export const exitLike = (exit: ChildExit): never => {
  if (exit.signal !== null) {
    process.kill(process.pid, exit.signal);
    return process.exit(128 + constants.signals[exit.signal]);
  }
  return process.exit(exit.code);
};

const spawnFailed = (path: string, cause: unknown) =>
  new ChildSpawnFailed({ path, cause, message: `failed to start ${path}` });
