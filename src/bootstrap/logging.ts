import { type InferErr, Result } from "better-result";
import {
  serializeTurnEvent,
  type TurnEvent,
} from "../conversation/controller.ts";
import { type RouteEvent, serializeRouteEvent } from "../conversation/route.ts";
import {
  type ObservationEvent,
  serializeObservationEvent,
} from "../infra/codex/observe.ts";
import type { openThreadStore } from "../infra/thread-store.ts";
import { loadLogPath, type loadStatePath } from "../runtime/config.ts";
import { openLogSink } from "../runtime/fs.boundary.ts";
import { createLogger, type LogSink } from "../runtime/logger.ts";
import type { Signal } from "../runtime/process.boundary.ts";
import {
  type ServerSignalEvent,
  serializeServerSignalEvent,
} from "./supervise.ts";

type LogEvent =
  | { event: "bridge_started" }
  | { event: "bridge_startup_failed"; reason: StartupFailure }
  | { event: "log_file_unavailable"; reason: LogFileFailure }
  | { event: "server_closed" }
  | ServerSignalEvent
  | { event: "claude_unavailable"; reason: ClaudeUnavailable }
  | { event: "bridge_signaled"; signal: Signal }
  | ObservationEvent
  | TurnEvent
  | RouteEvent;

type StartupFailure = "ServerPipesUnavailable";

type LogFileFailure = "LogPathNotAbsolute" | "LogFileOpenFailed";

type ClaudeUnavailable =
  | InferErr<ReturnType<typeof loadStatePath>>["_tag"]
  | InferErr<Awaited<ReturnType<typeof openThreadStore>>>["_tag"];

// The app may discard the server's stderr, so HARNEXUS_LOG_PATH keeps a copy in a file.
export const createBridgeLogger = (env: NodeJS.ProcessEnv) => {
  const file = loadLogPath(env).andThen((path) =>
    path === null ? Result.ok(null) : openLogSink(path),
  );
  const appendToFile = file.isOk() ? file.value : null;
  const sink: LogSink = (line) => {
    process.stderr.write(line);
    appendToFile?.(line);
  };
  const logger = createLogger(sink, serializeLogEvent);
  if (file.isErr()) {
    logger.log({ event: "log_file_unavailable", reason: file.error._tag });
  }
  return logger;
};

const serializeLogEvent = (entry: LogEvent) => {
  switch (entry.event) {
    case "bridge_started":
    case "server_closed":
      return { event: entry.event };
    case "bridge_startup_failed":
    case "log_file_unavailable":
      return { event: entry.event, reason: entry.reason };
    case "bridge_signaled":
      return { event: entry.event, signal: entry.signal };
    case "server_signaled":
    case "server_signal_failed":
      return serializeServerSignalEvent(entry);
    case "claude_unavailable":
      return { event: entry.event, reason: entry.reason };
    case "claude_turn":
      return serializeTurnEvent(entry);
    case "claude_request_refused":
    case "model_id_collision":
      return serializeRouteEvent(entry);
    case "rpc_message":
    case "rpc_unobserved":
      return serializeObservationEvent(entry);
  }
};
