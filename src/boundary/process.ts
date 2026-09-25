import { spawn } from "node:child_process";
import { constants } from "node:os";
import { Result, TaggedError } from "better-result";

export type Signals = NodeJS.Signals;

export type ChildExit =
  | { code: number; signal: null }
  | { code: null; signal: Signals };

export class ChildSpawnFailed extends TaggedError("ChildSpawnFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// Runs a child sharing this process's stdio and forwards termination signals
// to it until it exits.
export const runInherited = (
  path: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) =>
  new Promise<Result<ChildExit, ChildSpawnFailed>>((resolve) => {
    const child = spawn(path, args, { stdio: "inherit", env });
    const forward = (signal: Signals) => {
      child.kill(signal);
    };
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    const settle = (result: Result<ChildExit, ChildSpawnFailed>) => {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
      resolve(result);
    };

    child.once("error", (cause) => {
      settle(
        Result.err(
          new ChildSpawnFailed({
            path,
            cause,
            message: `failed to start ${path}`,
          }),
        ),
      );
    });
    child.once("exit", (code, signal) => {
      settle(
        Result.ok(
          signal === null
            ? { code: code ?? 1, signal: null }
            : { code: null, signal },
        ),
      );
    });
  });

// Ends this process the way the child ended, so the caller can tell a signal
// from an exit code. Falls back to 128 + signal number if the signal is ignored.
export const exitLike = (exit: ChildExit): never => {
  if (exit.signal !== null) {
    process.kill(process.pid, exit.signal);
    return process.exit(128 + constants.signals[exit.signal]);
  }
  return process.exit(exit.code);
};
