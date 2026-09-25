import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Result } from "better-result";
import {
  type ChildExit,
  ChildSpawnFailed,
  FORWARDED_SIGNALS,
  type Signals,
} from "../boundary/process.ts";
import type { Direction } from "./observe.ts";

type RelayOptions = {
  input: Readable;
  output: Writable;
  observer?: RelayObserver;
  shutdownGraceMs?: number;
};

type RelayObserver = {
  chunk: (direction: Direction, chunk: Uint8Array) => void;
  end: (direction: Direction) => void;
};

const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

// The child's stderr stays shared with this process; only stdin and stdout carry the protocol.
export const runRelay = (
  path: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  {
    input,
    output,
    observer,
    shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  }: RelayOptions,
) =>
  new Promise<Result<ChildExit, ChildSpawnFailed>>((resolve) => {
    const child = spawn(path, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env,
    });
    const timers: ReturnType<typeof setTimeout>[] = [];
    let settled = false;
    let stopping = false;

    // Each step waits shutdownGraceMs before escalating, so a child that exits on stdin EOF is never signaled.
    const stopChild = () => {
      if (stopping) return;
      stopping = true;
      child.stdin.end();
      timers.push(
        setTimeout(() => {
          child.kill("SIGTERM");
          timers.push(setTimeout(() => child.kill("SIGKILL"), shutdownGraceMs));
        }, shutdownGraceMs),
      );
    };

    const forwardSignal = (signal: Signals) => {
      child.kill(signal);
      if (stopping) return;
      stopping = true;
      timers.push(setTimeout(() => child.kill("SIGKILL"), shutdownGraceMs));
    };

    const settle = (result: Result<ChildExit, ChildSpawnFailed>) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      for (const signal of FORWARDED_SIGNALS) {
        process.off(signal, forwardSignal);
      }
      input.removeAllListeners("data");
      input.pause();
      resolve(result);
    };

    for (const signal of FORWARDED_SIGNALS) process.on(signal, forwardSignal);

    // An "error" after the child has a pid is a failed kill, which the exit that follows settles.
    child.once("error", (cause) => {
      if (child.pid !== undefined) return;
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

    const ignore = () => {};
    child.stdin.on("error", ignore);
    input.on("error", stopChild);
    output.on("error", stopChild);

    pump(input, child.stdin, "app_to_server", observer, stopChild, ignore);
    // The child closing stdout ends the conversation even if it keeps running, so it is stopped like an app disconnect.
    pump(child.stdout, output, "server_to_app", observer, stopChild, stopChild);

    // "close" follows the end of the child's stdout, so everything it wrote has been handed to output.
    child.once("close", (code, signal) => {
      const exit: ChildExit =
        signal === null
          ? { code: code ?? 1, signal: null }
          : { code: null, signal };
      if (output.destroyed || output.writableEnded) {
        settle(Result.ok(exit));
        return;
      }
      output.write(new Uint8Array(0), () => settle(Result.ok(exit)));
    });
  });

// Failures come from the write callback because Bun's process.stdout does not emit "error" on EPIPE; after one, the source is drained and dropped so it is never left paused.
const pump = (
  from: Readable,
  to: Writable,
  direction: Direction,
  observer: RelayObserver | undefined,
  onEnd: () => void,
  onWriteError: () => void,
) => {
  let broken = false;
  from.on("data", (chunk: Uint8Array) => {
    observer?.chunk(direction, chunk);
    if (broken) return;
    const accepted = to.write(chunk, (error) => {
      if (!error || broken) return;
      broken = true;
      from.resume();
      onWriteError();
    });
    if (!accepted && !broken) {
      from.pause();
      to.once("drain", () => from.resume());
    }
  });
  from.once("end", () => {
    observer?.end(direction);
    onEnd();
  });
};
