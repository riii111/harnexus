import { constants } from "node:os";
import { TaggedError } from "better-result";

export type Signals = NodeJS.Signals;

export type ChildExit =
  | { code: number; signal: null }
  | { code: null; signal: Signals };

export class ChildSpawnFailed extends TaggedError("ChildSpawnFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// Re-raising lets the caller tell a signal from an exit code; process.exit is reached only when the signal is ignored.
export const exitLike = (exit: ChildExit): never => {
  if (exit.signal !== null) {
    process.kill(process.pid, exit.signal);
    return process.exit(128 + constants.signals[exit.signal]);
  }
  return process.exit(exit.code);
};
