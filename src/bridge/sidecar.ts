import { openServerPipes } from "../boundary/process.ts";
import { createObserver } from "../rpc/observe.ts";
import { relayStreams } from "../rpc/relay.ts";
import { startAppToolsProbe } from "./app-tools-probe.ts";
import { createBridgeLogger } from "./logging.ts";

// Must match bin/harnexus-codex.
const SERVER_OUTPUT_FD = 3;
const SERVER_INPUT_FD = 4;

// Started by the launcher, which then execs Codex in its own place so the app keeps Codex as the process it started; Codex's exit status therefore reaches the app directly and is not observable here.
const logger = createBridgeLogger(process.env);

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
  ...pipes.value,
  observer: createObserver(logger.log),
});
logger.log({ event: "server_closed" });
process.exit(0);
