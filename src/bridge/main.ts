import { openServerPipes, type Signals } from "../boundary/process.ts";
import { createObserver } from "../rpc/observe.ts";
import { relayStreams } from "../rpc/relay.ts";
import { loadShutdownGraceMs } from "../shared/config.ts";
import { createBridgeLogger } from "./logging.ts";
import { stopLingeringServer, watchServer } from "./supervise.ts";

// Must match bin/harnexus-codex.
const SERVER_OUTPUT_FD = 3;
const SERVER_INPUT_FD = 4;

// Codex is not a child of this process, so its exit status goes to the app and is not observable here.
const logger = createBridgeLogger(process.env);
const server = watchServer(process.env);

const pipes = openServerPipes(SERVER_OUTPUT_FD, SERVER_INPUT_FD);
if (pipes.isErr()) {
  logger.log({ event: "bridge_startup_failed", reason: pipes.error._tag });
  process.exit(1);
}

logger.log({ event: "bridge_started" });
const shutdownGraceMs = loadShutdownGraceMs(process.env);
await relayStreams({
  input: process.stdin,
  output: process.stdout,
  serverInput: pipes.value.serverInput,
  serverOutput: pipes.value.serverOutput,
  observer: createObserver(logger.log),
  signalServer,
  shutdownGraceMs,
});
logger.log({ event: "server_closed" });
pipes.value.serverInput.destroy();
await stopLingeringServer({
  isRunning: server.isRunning,
  signal: signalServer,
  graceMs: shutdownGraceMs,
});
process.exit(0);

function signalServer(signal: Signals) {
  if (server.signal(signal)) logger.log({ event: "server_signaled", signal });
}
