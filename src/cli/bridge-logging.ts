import { type InferErr, Result } from "better-result";

import {
  type CloudLogEvent,
  serializeCloudEvent,
} from "../features/conversation/claude/cloud/runtime.ts";
import {
  type ClaudeLogEvent,
  isClaudeTurnEvent,
  serializeClaudeTurnEvent,
} from "../features/conversation/claude/runtime.ts";
import {
  type ExternalLogEvent,
  serializeExternalEvent,
} from "../features/conversation/external/conversations.ts";
import {
  isRouteEvent,
  type RouteEvent,
  serializeRouteEvent,
} from "../features/conversation/route.ts";
import { serializeTurnEvent } from "../features/conversation/turn/controller.ts";
import type { BridgeIdentity } from "../features/diagnostics/bridge-identity.ts";
import type {
  loadClaudeModels,
  loadEffortSettings,
} from "../infra/claude/session.ts";
import {
  isObservationEvent,
  type ObservationEvent,
  serializeObservationEvent,
} from "../infra/codex/transport/observe.ts";
import type { openThreadStore } from "../infra/thread-store.ts";
import {
  type loadCallSocketPath,
  loadLogPath,
  type loadPermissionMode,
  loadStatePath,
} from "../lib/config.ts";
import type { loadConnectionSettings } from "../lib/connection-settings.boundary.ts";
import { openLogSink } from "../lib/fs.boundary.ts";
import { createLogger } from "../lib/logger.ts";
import type { Signal } from "../lib/process.boundary.ts";
import type { serveLines } from "../lib/socket.boundary.ts";
import {
  type BridgeFailedEvent,
  type ServerSignalEvent,
  serializeServerSignalEvent,
} from "./supervise.ts";

type LogEvent =
  | ({ event: "bridge_started" } & BridgeIdentity)
  | { event: "compatibility_report_failed" }
  | { event: "bridge_startup_failed"; reason: StartupFailure }
  | { event: "log_file_unavailable"; reason: LogFileFailure }
  | { event: "server_closed" }
  | ServerSignalEvent
  | BridgeFailedEvent
  | { event: "claude_unavailable"; reason: ClaudeUnavailable }
  | { event: "effort_settings_unavailable"; reason: EffortSettingsFailure }
  | { event: "claude_models_unavailable"; reason: ModelsFailure }
  | { event: "claude_models_loaded"; count: number }
  | { event: "connection_settings_unavailable"; reason: SettingsFailure }
  | { event: "bridge_signaled"; signal: Signal }
  | { event: "call_socket_listening" }
  | { event: "call_socket_unavailable"; reason: CallSocketFailure }
  | ObservationEvent
  | ClaudeLogEvent
  | CloudLogEvent
  | ExternalLogEvent
  | { event: "external_state_unavailable" }
  | RouteEvent;

type CallSocketFailure =
  | InferErr<ReturnType<typeof loadStatePath>>["_tag"]
  | InferErr<ReturnType<typeof loadCallSocketPath>>["_tag"]
  | InferErr<Awaited<ReturnType<typeof serveLines>>>["_tag"];

type StartupFailure =
  | "ServerPipesUnavailable"
  | "UnverifiedCodex"
  | "MaintenanceRunning";

type LogFileFailure =
  | "StatePathNotAbsolute"
  | "LogPathNotAbsolute"
  | "LogFileOpenFailed";

type ClaudeUnavailable =
  | InferErr<ReturnType<typeof loadPermissionMode>>["_tag"]
  | InferErr<ReturnType<typeof loadStatePath>>["_tag"]
  | InferErr<Awaited<ReturnType<typeof openThreadStore>>>["_tag"]
  | "StateLockFailed";

type EffortSettingsFailure = InferErr<
  Awaited<ReturnType<typeof loadEffortSettings>>
>["_tag"];

type SettingsFailure = InferErr<
  Awaited<ReturnType<typeof loadConnectionSettings>>
>["_tag"];

type ModelsFailure = InferErr<
  Awaited<ReturnType<typeof loadClaudeModels>>
>["_tag"];

// The bridge's logger, writing to stderr and to the log file.
export const createBridgeLogger = (env: NodeJS.ProcessEnv) => {
  const file = loadStatePath(env)
    .andThen((statePath) => loadLogPath(env, statePath))
    .andThen((log) =>
      log === null
        ? Result.ok(null)
        : openLogSink(log.path).map((append) => ({
            append,
            explicit: log.explicit,
          })),
    );
  // The app may discard the server's stderr, so a copy goes to a file unless HARNEXUS_LOG_PATH is off.
  const toStderr = createLogger((line) => process.stderr.write(line), withPid);
  const toFile =
    file.isOk() && file.value !== null
      ? createLogger(file.value.append, withPid)
      : null;
  // The default file leaves out each relayed message, which would fill it within one long turn; a path set by hand keeps them.
  const keepsMessages = file.isOk() && file.value?.explicit === true;
  const logger = {
    log: (entry: LogEvent) => {
      if (entry.event !== "rpc_message" || keepsMessages) {
        toStderr.log(entry);
        toFile?.log(entry);
      }
    },
  };
  if (file.isErr()) {
    logger.log({ event: "log_file_unavailable", reason: file.error._tag });
  }

  return logger;
};

const withPid = (entry: LogEvent) => ({
  // Bridges of every app-server connection append to one file, so the pid tells their lines apart.
  pid: process.pid,
  ...serializeLogEvent(entry),
});

const serializeLogEvent = (entry: LogEvent) => {
  switch (entry.event) {
    case "bridge_started":
      return {
        event: entry.event,
        commit: entry.commit,
        bun: entry.bun,
        sdk: entry.sdk,
        claudeCode: entry.claudeCode,
        settings: {
          permissionMode: entry.settings.permissionMode,
          unverifiedCodex: entry.settings.unverifiedCodex,
          statePath: entry.settings.statePath,
          logPath: entry.settings.logPath,
          callSocket: entry.settings.callSocket,
        },
      };
    case "compatibility_report_failed":
    case "server_closed":
    case "call_socket_listening":
      return { event: entry.event };
    case "bridge_startup_failed":
    case "bridge_failed":
    case "log_file_unavailable":
      return { event: entry.event, reason: entry.reason };
    case "bridge_signaled":
      return { event: entry.event, signal: entry.signal };
    case "server_signaled":
    case "server_signal_failed":
      return serializeServerSignalEvent(entry);
    case "claude_unavailable":
    case "effort_settings_unavailable":
    case "claude_models_unavailable":
    case "connection_settings_unavailable":
    case "call_socket_unavailable":
      return { event: entry.event, reason: entry.reason };
    case "claude_models_loaded":
      return { event: entry.event, count: entry.count };
    case "claude_cloud":
      return serializeCloudEvent(entry);
    case "external_adapter":
      return serializeExternalEvent(entry);
    case "external_state_unavailable":
      return { event: entry.event };
    case "claude_turn":
      return isClaudeTurnEvent(entry)
        ? serializeClaudeTurnEvent(entry)
        : serializeTurnEvent(entry);
    default:
      if (isRouteEvent(entry)) return serializeRouteEvent(entry);
      if (isObservationEvent(entry)) return serializeObservationEvent(entry);
      entry satisfies never;
      return { event: "unknown_log_event" };
  }
};
