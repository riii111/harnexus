import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { Result, TaggedError } from "better-result";
import { isObject } from "../shared/object.ts";

export type Signal = NodeJS.Signals;

class ChildSpawnFailed extends TaggedError("ChildSpawnFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

class ServerPipesUnavailable extends TaggedError("ServerPipesUnavailable")<{
  cause: unknown;
  message: string;
}> {}

// Kills the process once the first line arrives or timeoutMs passes.
export const readFirstLine = (
  path: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) =>
  new Promise<string | null>((resolve) => {
    const spawned = Result.try({
      try: () =>
        spawn(path, args, { stdio: ["ignore", "pipe", "ignore"], env }),
      catch: (cause) => spawnFailed(path, cause),
    });
    if (spawned.isErr()) {
      resolve(null);
      return;
    }
    const child = spawned.value;
    let output = "";
    const finish = (line: string | null) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(line);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.once("error", () => finish(null));
    child.stdout.on("data", (chunk: Uint8Array) => {
      output += Buffer.from(chunk).toString();
      const end = output.indexOf("\n");
      if (end >= 0) finish(output.slice(0, end));
    });
    child.once("close", () => finish(null));
  });

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

const spawnFailed = (path: string, cause: unknown) =>
  new ChildSpawnFailed({ path, cause, message: `failed to start ${path}` });
