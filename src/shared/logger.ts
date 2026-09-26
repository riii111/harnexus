import type { InferErr } from "better-result";
import type { Signal } from "../boundary/process.ts";
import type { ServerSignalEvent } from "../bridge/supervise.ts";
import type { ObservationEvent } from "../rpc/observe.ts";
import type { RouteEvent } from "../rpc/route.ts";
import type { openThreadStore } from "../state/thread-store.ts";
import type { TurnEvent } from "../turn/controller.ts";
import type { loadStatePath } from "./config.ts";

// serialize() copies only known fields, so request bodies, conversations, code and credentials cannot reach the log even through a widened object.
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

export type LogSink = (line: string) => void;

export const createLogger = (sink: LogSink) => ({
  log: (entry: LogEvent) => {
    const record = { time: new Date().toISOString(), ...serialize(entry) };
    sink(`${JSON.stringify(record)}\n`);
  },
});

const serialize = (entry: LogEvent) => {
  switch (entry.event) {
    case "bridge_started":
    case "server_closed":
      return { event: entry.event };
    case "bridge_startup_failed":
    case "log_file_unavailable":
      return { event: entry.event, reason: entry.reason };
    case "server_signaled":
    case "bridge_signaled":
      return { event: entry.event, signal: entry.signal };
    case "server_signal_failed":
      return { event: entry.event, signal: entry.signal, code: entry.code };
    case "claude_unavailable":
      return { event: entry.event, reason: entry.reason };
    case "claude_turn":
      return serializeTurn(entry);
    case "claude_request_refused":
      return { event: entry.event, method: entry.method, reason: entry.reason };
    case "model_id_collision":
      return { event: entry.event, model: entry.model };
    case "rpc_message":
      return {
        event: entry.event,
        direction: entry.direction,
        kind: entry.kind,
        method: entry.method,
        id: entry.id,
        ...(entry.mcpStartup !== null && {
          mcpStartup: {
            server: entry.mcpStartup.server,
            status: entry.mcpStartup.status,
            failure: entry.mcpStartup.failure,
          },
        }),
        ...(entry.tools.length > 0 && {
          tools: entry.tools.map(({ name, inputSchema }) => ({
            name,
            inputSchema,
          })),
        }),
      };
    case "rpc_unobserved":
      return {
        event: entry.event,
        direction: entry.direction,
        reason: entry.reason,
      };
  }
};

const serializeTurn = (entry: TurnEvent) => {
  switch (entry.step) {
    case "started":
      return { event: entry.event, step: entry.step };
    case "finished":
      return {
        event: entry.event,
        step: entry.step,
        status: entry.status,
        error: entry.error,
      };
    case "refused":
      return {
        event: entry.event,
        step: entry.step,
        reason: entry.reason,
        error: entry.error,
      };
    case "interrupt_failed":
    case "session_not_saved":
    case "run_state_not_saved":
      return { event: entry.event, step: entry.step, error: entry.error };
  }
};
