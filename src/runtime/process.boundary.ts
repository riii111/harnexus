import { type ExecFileException, execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream, writeSync } from "node:fs";
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

export class CommandFailed extends TaggedError("CommandFailed")<{
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
    try: async () => {
      const { error, stdout } = await captureCommand(file, args, { timeoutMs });
      if (error !== null) throw error;
      return stdout;
    },
    catch: (cause) =>
      new CommandFailed({
        command: file,
        cause,
        message: `${file} failed`,
      }),
  });

export type CommandOutput = {
  status: number;
  stdout: string;
  stderr: string;
};

// A command that ran is ok whatever its exit status, so the caller decides what a failure means; one that could not start or hung past the timeout is an error.
export const runCommand = (
  file: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  timeoutMs = COMMAND_TIMEOUT_MS,
) =>
  Result.tryPromise({
    try: async (): Promise<CommandOutput> => {
      const { error, stdout, stderr } = await captureCommand(file, args, {
        env,
        timeoutMs,
      });
      if (error === null) return { status: 0, stdout, stderr };
      if (typeof error.code === "number" && !error.killed)
        return { status: error.code, stdout, stderr };
      throw error;
    },
    catch: (cause) =>
      new CommandFailed({
        command: file,
        cause,
        message:
          isObject(cause) && cause.killed === true
            ? `${file} was stopped after ${timeoutMs} ms`
            : `cannot run ${file}`,
      }),
  });

// No pipes or awaited exit: a notification process must not keep the relay alive or hold its protocol descriptors.
export const startDetachedCommand = (file: string, args: readonly string[]) =>
  Result.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(file, [...args], {
          detached: true,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      }),
    catch: (cause) =>
      new CommandFailed({
        command: file,
        cause,
        message: `cannot start ${file}`,
      }),
  });

// The one place a command's end is awaited: a failed command is returned as the error, so each caller decides what an exit status, a kill or a missing file means.
export const captureCommand = (
  file: string,
  args: readonly string[],
  options: { env?: Record<string, string | undefined>; timeoutMs: number },
) =>
  new Promise<{
    error: ExecFileException | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    execFile(
      file,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: COMMAND_OUTPUT_LIMIT,
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });

const COMMAND_TIMEOUT_MS = 10_000;

const COMMAND_OUTPUT_LIMIT = 16 * 1024 * 1024;

// The launcher retains the app descriptors until all bridge startup work succeeds.
export const announceBridgeStatus = (
  status:
    | { ready: true }
    | { ready: false; reason: "UnverifiedCodex"; version: string | null },
) =>
  Result.try({
    try: () => {
      writeSync(5, JSON.stringify(status));
    },
    catch: (cause) =>
      new ServerPipesUnavailable({
        cause,
        message: "launcher readiness pipe is unavailable",
      }),
  });
