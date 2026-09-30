import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { Result, TaggedError } from "better-result";
import { isObject } from "./object.ts";

export type Signal = NodeJS.Signals;

class ServerPipesUnavailable extends TaggedError("ServerPipesUnavailable")<{
  cause: unknown;
  message: string;
}> {}

export const openServerPipes = (
  serverOutputFd: number,
  serverInputFd: number,
) =>
  Result.try({
    try: () => ({
      serverOutput: createReadStream("", { fd: serverOutputFd }),
      serverInput: createWriteStream("", { fd: serverInputFd }),
    }),
    catch: (cause) =>
      new ServerPipesUnavailable({
        cause,
        message: "the server pipes were not inherited",
      }),
  });

class ProcessSignalFailed extends TaggedError("ProcessSignalFailed")<{
  pid: number;
  code: string | null;
  cause: unknown;
  message: string;
}> {}

export const signalProcess = (pid: number, signal: Signal) =>
  Result.try({
    try: () => {
      process.kill(pid, signal);
    },
    catch: (cause) =>
      new ProcessSignalFailed({
        pid,
        code:
          isObject(cause) && typeof cause.code === "string" ? cause.code : null,
        cause,
        message: `cannot send ${signal} to ${pid}`,
      }),
  });

class CommandFailed extends TaggedError("CommandFailed")<{
  command: string;
  cause: unknown;
  message: string;
}> {}

// Only the output is returned, so a caller decides what of it may be shown; a command that hangs is stopped at the timeout.
export const readCommandOutput = (
  file: string,
  args: readonly string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
) =>
  Result.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        execFile(
          file,
          [...args],
          { timeout: timeoutMs, maxBuffer: COMMAND_OUTPUT_LIMIT },
          (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
        );
      }),
    catch: (cause) =>
      new CommandFailed({
        command: file,
        cause,
        message: `${file} failed`,
      }),
  });

const COMMAND_TIMEOUT_MS = 10_000;

const COMMAND_OUTPUT_LIMIT = 16 * 1024 * 1024;
