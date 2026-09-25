import type { Readable, Writable } from "node:stream";
import { Result } from "better-result";
import {
  type ChildExit,
  FORWARDED_SIGNALS,
  type PipedChild,
  type Signals,
  startChild,
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
  options: RelayOptions,
) =>
  Result.gen(async function* () {
    const child = yield* Result.await(startChild(path, args, env));
    return Result.ok(await relayUntilExit(child, options));
  });

// For a server this process did not start, so its exit is not observable here: the relay ends when the server closes its output and everything it wrote has been handed to the app.
export const relayStreams = ({
  input,
  output,
  serverInput,
  serverOutput,
  observer,
}: {
  input: Readable;
  output: Writable;
  serverInput: Writable;
  serverOutput: Readable;
  observer?: RelayObserver;
}) =>
  new Promise<void>((resolve) => {
    let settled = false;
    const stopServer = () => {
      if (!serverInput.writableEnded) serverInput.end();
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      input.removeAllListeners("data");
      input.pause();
      resolve();
    };
    const finish = () => {
      if (output.destroyed || output.writableEnded) {
        settle();
        return;
      }
      output.write(new Uint8Array(0), settle);
    };

    serverInput.on("error", () => {});
    input.on("error", stopServer);
    output.on("error", stopServer);
    serverOutput.on("error", finish);

    pump(input, serverInput, "app_to_server", observer, {
      onEnd: stopServer,
      onWriteError: () => {},
    });
    pump(serverOutput, output, "server_to_app", observer, {
      onEnd: finish,
      onWriteError: stopServer,
    });
  });

// Never rejects: every stream failure is turned into stopping the child, and the child's exit is the only outcome.
const relayUntilExit = (
  child: PipedChild,
  {
    input,
    output,
    observer,
    shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  }: RelayOptions,
) =>
  new Promise<ChildExit>((resolve) => {
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

    const settle = (exit: ChildExit) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      for (const signal of FORWARDED_SIGNALS) {
        process.off(signal, forwardSignal);
      }
      input.removeAllListeners("data");
      input.pause();
      resolve(exit);
    };

    for (const signal of FORWARDED_SIGNALS) process.on(signal, forwardSignal);

    const ignore = () => {};
    child.stdin.on("error", ignore);
    input.on("error", stopChild);
    output.on("error", stopChild);

    // A failed write to the child means it is gone, and its exit settles the relay.
    pump(input, child.stdin, "app_to_server", observer, {
      onEnd: stopChild,
      onWriteError: ignore,
    });
    // The child closing stdout ends the conversation even if it keeps running, so it is stopped like an app disconnect.
    pump(child.stdout, output, "server_to_app", observer, {
      onEnd: stopChild,
      onWriteError: stopChild,
    });

    // "close" follows the end of the child's stdout, so everything it wrote has been handed to output.
    child.once("close", (code, signal) => {
      const exit: ChildExit =
        signal === null
          ? { code: code ?? 1, signal: null }
          : { code: null, signal };
      if (output.destroyed || output.writableEnded) {
        settle(exit);
        return;
      }
      output.write(new Uint8Array(0), () => settle(exit));
    });
  });

// Failures come from the write callback because Bun's process.stdout does not emit "error" on EPIPE; after one, the source is drained and dropped so it is never left paused.
const pump = (
  from: Readable,
  to: Writable,
  direction: Direction,
  observer: RelayObserver | undefined,
  { onEnd, onWriteError }: { onEnd: () => void; onWriteError: () => void },
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
