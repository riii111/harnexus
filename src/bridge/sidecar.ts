import type { Readable, Writable } from "node:stream";
import {
  openServerPipes,
  type Signals,
  signalProcess,
} from "../boundary/process.ts";
import { createLineInjector, createOwnResponseFilter } from "../rpc/inject.ts";
import { createObserver, type Direction } from "../rpc/observe.ts";
import { type RelayObserver, relayStreams } from "../rpc/relay.ts";
import { loadShutdownGraceMs } from "../shared/config.ts";
import { startAppToolsProbe } from "./app-tools-probe.ts";
import { createBridgeLogger } from "./logging.ts";
import { createToolCallProbe } from "./tool-call-probe.ts";

// Must match bin/harnexus-codex.
const SERVER_OUTPUT_FD = 3;
const SERVER_INPUT_FD = 4;

// Codex is not a child of this process, so its exit status goes to the app and is not observable here.
const logger = createBridgeLogger(process.env);
const serverPid = process.ppid;

const pipes = openServerPipes(SERVER_OUTPUT_FD, SERVER_INPUT_FD);
if (pipes.isErr()) {
  logger.log({ event: "bridge_startup_failed", reason: pipes.error._tag });
  process.exit(1);
}

logger.log({ event: "bridge_started" });
void startAppToolsProbe(process.env, logger.log);
await relayStreams({
  input: process.stdin,
  output: process.stdout,
  ...withToolCallProbe(pipes.value, createObserver(logger.log)),
  signalServer,
  shutdownGraceMs: loadShutdownGraceMs(process.env),
});
logger.log({ event: "server_closed" });
process.exit(0);

// The parent is Codex until it exits; checking it first keeps a reused pid from being signaled.
function signalServer(signal: Signals) {
  if (process.ppid !== serverPid) return;
  if (signalProcess(serverPid, signal).isOk()) {
    logger.log({ event: "server_signaled", signal });
  }
}

function withToolCallProbe(
  {
    serverInput,
    serverOutput,
  }: { serverInput: Writable; serverOutput: Readable },
  observer: RelayObserver,
) {
  const probe = createToolCallProbe(process.env, logger.log);
  if (probe === null) return { serverInput, serverOutput, observer };
  const injector = createLineInjector(serverInput);
  const filtered = createOwnResponseFilter(
    probe.isOwnResponse,
    probe.onOwnResponse,
  );
  serverOutput.on("error", () => filtered.end());
  probe.attach(injector.inject);
  return {
    serverInput: injector.stream,
    serverOutput: serverOutput.pipe(filtered),
    observer: {
      chunk: (direction: Direction, chunk: Uint8Array) => {
        observer.chunk(direction, chunk);
        probe.observer.chunk(direction, chunk);
      },
      end: (direction: Direction) => {
        observer.end(direction);
        probe.observer.end(direction);
      },
    },
  };
}
