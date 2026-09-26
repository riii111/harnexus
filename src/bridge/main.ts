import { constants } from "node:os";
import type { Readable, Writable } from "node:stream";
import { openServerPipes } from "../boundary/process.ts";
import { startClaudeSession } from "../claude/session.ts";
import { createDelegationWatch } from "../link/delegations.ts";
import { createCodexLink } from "../mcp/codex-link.ts";
import { createLineInjector } from "../rpc/inject.ts";
import { createLineRewriter } from "../rpc/line-rewriter.ts";
import { createObserver } from "../rpc/observe.ts";
import { type RelayObserver, relayStreams } from "../rpc/relay.ts";
import { createRouter } from "../rpc/route.ts";
import { attachServerRequests } from "../rpc/server-requests.ts";
import { loadShutdownGraceMs, loadStatePath } from "../shared/config.ts";
import { openThreadStore } from "../state/thread-store.ts";
import { createTurnController } from "../turn/controller.ts";
import { createBridgeLogger } from "./logging.ts";
import {
  serverFromEnv,
  signalWithLog,
  stopLingeringServer,
} from "./supervise.ts";

// Must match bin/harnexus-codex.
const SERVER_OUTPUT_FD = 3;
const SERVER_INPUT_FD = 4;

// Handled so Claude processes are closed before exit; the server still learns of the exit from EOF on its input as before.
const BRIDGE_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

// The server is not a child of this process, so its exit status goes to the app and is not observable here.
const logger = createBridgeLogger(process.env);
const server = serverFromEnv(process.env);

const pipes = openServerPipes(SERVER_OUTPUT_FD, SERVER_INPUT_FD);
if (pipes.isErr()) {
  logger.log({ event: "bridge_startup_failed", reason: pipes.error._tag });
  process.exit(1);
}

logger.log({ event: "bridge_started" });
const stopServer = {
  signal: signalWithLog(server, logger.log),
  graceMs: loadShutdownGraceMs(process.env),
};
const claude = await withClaude({
  ...pipes.value,
  observer: createObserver(logger.log),
});
for (const signal of BRIDGE_SIGNALS) {
  process.once(signal, () => {
    logger.log({ event: "bridge_signaled", signal });
    claude.closeAll();
    process.exit(128 + constants.signals[signal]);
  });
}
await relayStreams({ ...claude.streams, stopServer });
logger.log({ event: "server_closed" });
claude.closeAll();
pipes.value.serverInput.destroy();
await stopLingeringServer({ isRunning: server.isRunning, ...stopServer });
process.exit(0);

// Without its thread store the bridge offers no Claude model and relays everything, so Codex threads keep working.
async function withClaude(relay: {
  serverInput: Writable;
  serverOutput: Readable;
  observer: RelayObserver;
}) {
  const plain = {
    streams: { appInput: process.stdin, appOutput: process.stdout, ...relay },
    closeAll: () => {},
  };
  const path = loadStatePath(process.env);
  if (path.isErr()) {
    logger.log({ event: "claude_unavailable", reason: path.error._tag });
    return plain;
  }
  const store = await openThreadStore(path.value);
  if (store.isErr()) {
    logger.log({ event: "claude_unavailable", reason: store.error._tag });
    return plain;
  }
  const appInjector = createLineInjector(process.stdout);
  // The bridge's own requests to the server are answered before the router reads the server output, so their responses never reach the app.
  const serverCalls = attachServerRequests(relay);
  const delegations = createDelegationWatch();
  const turns = createTurnController({
    store: store.value,
    startSession: startClaudeSession,
    openLink: (callerThreadId) =>
      createCodexLink({
        callerThreadId,
        store: store.value,
        request: serverCalls.request,
        delegations,
      }),
    send: (message) => appInjector.inject(`${JSON.stringify(message)}\n`),
    log: logger.log,
  });
  const router = createRouter(turns, logger.log, delegations.observe);
  const appRewriter = createLineRewriter(router.fromApp);
  const serverRewriter = createLineRewriter(router.fromServer);
  process.stdin.on("error", (error) => appRewriter.destroy(error));
  return {
    streams: {
      ...relay,
      appInput: process.stdin.pipe(appRewriter),
      appOutput: appInjector.stream,
      serverInput: serverCalls.serverInput,
      serverOutput: serverCalls.serverOutput.pipe(serverRewriter),
    },
    closeAll: turns.closeAll,
  };
}
