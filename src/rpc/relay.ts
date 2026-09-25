import type { Readable, Writable } from "node:stream";
import type { Signals } from "../boundary/process.ts";
import type { Direction } from "./observe.ts";

export type RelayObserver = {
  chunk: (direction: Direction, chunk: Uint8Array) => void;
  end: (direction: Direction) => void;
};

const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

// The server is not a child here, so the relay ends on its output EOF instead of its exit.
export const relayStreams = ({
  input,
  output,
  serverInput,
  serverOutput,
  observer,
  signalServer,
  shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
}: {
  input: Readable;
  output: Writable;
  serverInput: Writable;
  serverOutput: Readable;
  observer?: RelayObserver;
  signalServer?: (signal: Signals) => void;
  shutdownGraceMs?: number;
}) =>
  new Promise<void>((resolve) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let settled = false;
    let stopping = false;
    // A server that ignores EOF on stdin would otherwise keep running after the app has gone.
    const stopServer = () => {
      if (!serverInput.writableEnded && !serverInput.destroyed) {
        serverInput.end();
      }
      if (stopping || signalServer === undefined) return;
      stopping = true;
      timers.push(
        setTimeout(() => {
          signalServer("SIGTERM");
          timers.push(
            setTimeout(() => signalServer("SIGKILL"), shutdownGraceMs),
          );
        }, shutdownGraceMs),
      );
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
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

    serverInput.on("error", stopServer);
    input.on("error", stopServer);
    output.on("error", stopServer);
    serverOutput.on("error", finish);

    pump(input, serverInput, "app_to_server", observer, {
      onEnd: stopServer,
      onWriteError: stopServer,
    });
    pump(serverOutput, output, "server_to_app", observer, {
      onEnd: finish,
      onWriteError: stopServer,
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
