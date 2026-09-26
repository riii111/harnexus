import { createReadStream, createWriteStream } from "node:fs";
import { Result, TaggedError } from "better-result";
import { isObject } from "../shared/object.ts";

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
