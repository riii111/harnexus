import { constants } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createModelCatalog, effortRule } from "../infra/claude/models.ts";
import {
  claudeSessionExists,
  loadClaudeModels,
  loadEffortSettings,
  readClaudeSession,
  readClaudeSubagents,
  startClaudeSession,
} from "../infra/claude/session.ts";
import {
  listClaudeConversations,
  readLastRecordUuid,
} from "../infra/claude/transcripts.ts";
import {
  cronRecordPath,
  openCronRecord,
} from "../infra/codex/automations.boundary.ts";
import { createLineInjector } from "../infra/codex/inject.ts";
import { createLineRewriter } from "../infra/codex/line-rewriter.ts";
import { createObserver } from "../infra/codex/observe.ts";
import { type RelayObserver, relayStreams } from "../infra/codex/relay.ts";
import { attachServerRequests } from "../infra/codex/server-requests.ts";
import { isVerifiedCodex } from "../infra/codex/versions.ts";
import { openThreadStore } from "../infra/thread-store.ts";
import {
  loadCallSocketPath,
  loadPermissionMode,
  loadShutdownGraceMs,
  loadStatePath,
  loadUnverifiedCodexPolicy,
} from "../runtime/config.ts";
import {
  announceBridgeStatus,
  openServerPipes,
  readCommandOutput,
} from "../runtime/process.boundary.ts";
import { serveLinesWhenFree } from "../runtime/socket.boundary.ts";
import { readBridgeIdentity } from "./bridge-identity.ts";
import { connectClaudeThreads } from "./claude-threads.ts";
import { reportCompatibilityFailure } from "./compatibility.boundary.ts";
import { createBridgeLogger } from "./logging.ts";
import {
  serverFromEnv,
  signalWithLog,
  stopLingeringServer,
} from "./supervise.ts";
import { codexHome } from "./task/request.ts";

const REPO = join(import.meta.dir, "..", "..");

// Must match bin/harnexus-codex.
const SERVER_OUTPUT_FD = 3;
const SERVER_INPUT_FD = 4;

// Handled so Claude processes are closed before exit; the server still learns of the exit from EOF on its input as before.
const BRIDGE_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

// The server is not a child of this process, so its exit status goes to the app and is not observable here.
const logger = createBridgeLogger(process.env);
const server = serverFromEnv(process.env);

if (
  process.argv.includes("--launcher") &&
  loadUnverifiedCodexPolicy(process.env) === "fallback"
) {
  const version = await readCommandOutput(
    process.env.HARNEXUS_CODEX_PATH ?? "",
    ["--version"],
  );
  const parsed = version.isOk()
    ? (/(\d+\.\d+\.\d+\S*)/.exec(version.value)?.[1] ?? null)
    : null;
  if (!isVerifiedCodex(parsed)) {
    logger.log({ event: "bridge_startup_failed", reason: "UnverifiedCodex" });
    announceBridgeStatus({
      ready: false,
      reason: "UnverifiedCodex",
      version: parsed,
    });
    process.exit(1);
  }
}

const pipes = openServerPipes(SERVER_OUTPUT_FD, SERVER_INPUT_FD);
if (pipes.isErr()) {
  logger.log({ event: "bridge_startup_failed", reason: pipes.error._tag });
  process.exit(1);
}

logger.log({
  event: "bridge_started",
  ...(await readBridgeIdentity(REPO, process.env)),
});
const stopServer = {
  signal: signalWithLog(server, logger.log),
  graceMs: loadShutdownGraceMs(process.env),
};
const claude = await withClaude({
  ...pipes.value,
  observer: createObserver(logger.log, { shapes: "sampled" }),
});
if (
  process.argv.includes("--launcher") &&
  announceBridgeStatus({ ready: true }).isErr()
) {
  claude.closeAll();
  process.exit(1);
}
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
  const statePath = loadStatePath(process.env);
  if (statePath.isErr()) {
    logger.log({ event: "claude_unavailable", reason: statePath.error._tag });
    return plain;
  }
  const store = await openThreadStore(statePath.value);
  if (store.isErr()) {
    logger.log({ event: "claude_unavailable", reason: store.error._tag });
    return plain;
  }
  const permissionMode = loadPermissionMode(process.env);
  if (permissionMode.isErr()) {
    logger.log({
      event: "claude_unavailable",
      reason: permissionMode.error._tag,
    });
    return plain;
  }
  const catalog = createModelCatalog();
  // Not awaited, since the app lists models before Claude Code can answer and holding that answer would hold every later server line; the app asks again later.
  void loadClaudeModels().then((loaded) => {
    if (loaded.isErr()) {
      logger.log({
        event: "claude_models_unavailable",
        reason: loaded.error._tag,
      });
      return;
    }
    catalog.replace(loaded.value);
    logger.log({ event: "claude_models_loaded", count: loaded.value.length });
  });
  const settings = await loadEffortSettings();
  if (settings.isErr()) {
    logger.log({
      event: "effort_settings_unavailable",
      reason: settings.error._tag,
    });
  }
  const appInjector = createLineInjector(process.stdout);
  // The bridge's own requests to the server are answered before the router reads the server output, so their responses never reach the app.
  const serverCalls = attachServerRequests(relay);
  let callSocketOpen = false;
  const { router, closeAll, callGateway } = connectClaudeThreads({
    store: store.value,
    permissionMode: permissionMode.value,
    request: serverCalls.request,
    startSession: (session, signal) =>
      startClaudeSession(
        { ...session, exposeThreadId: callSocketOpen },
        undefined,
        signal,
      ),
    findSession: claudeSessionExists,
    listConversations: (cwd, since) => listClaudeConversations(cwd, { since }),
    lastRecordOf: (sessionId) => readLastRecordUuid(sessionId),
    readSession: (sessionId) => readClaudeSession(sessionId),
    readSubagents: (sessionId) => readClaudeSubagents(sessionId),
    // Unreadable settings leave threads with none picked on the model default, which is still the level the app shows.
    effortRule: effortRule(
      settings.isOk() ? settings.value : {},
      catalog.effortsOf,
    ),
    claudeModels: catalog.models,
    codexHome: codexHome(process.env),
    cronRecord: openCronRecord(cronRecordPath(statePath.value)),
    send: (message) => appInjector.inject(`${JSON.stringify(message)}\n`),
    log: (event) => {
      logger.log(event);
      if (event.event === "codex_incompatible") {
        void reportCompatibilityFailure(event, process.env).then((reported) => {
          if (reported.isErr())
            logger.log({ event: "compatibility_report_failed" });
        });
      }
    },
  });
  // Not awaited: while another bridge holds the socket this one keeps waiting to take it over, and threads started before then go without CODEX_THREAD_ID.
  void openCallSocket(callGateway.handle).then((open) => {
    callSocketOpen = open;
  });
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
    closeAll,
  };
}

// A failure only leaves the socket closed; the app and its Claude threads work as before.
async function openCallSocket(handle: (line: string) => Promise<string>) {
  const path = loadStatePath(process.env).andThen((statePath) =>
    loadCallSocketPath(process.env, statePath),
  );
  if (path.isErr()) {
    logger.log({ event: "call_socket_unavailable", reason: path.error._tag });
    return false;
  }
  if (path.value === null) return false;
  const served = await serveLinesWhenFree(path.value, handle, {
    onInUse: () =>
      logger.log({ event: "call_socket_unavailable", reason: "SocketInUse" }),
  });
  if (served.isErr()) {
    logger.log({
      event: "call_socket_unavailable",
      reason: served.error._tag,
    });
    return false;
  }
  logger.log({ event: "call_socket_listening" });
  return true;
}
