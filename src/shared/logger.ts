import type { Signals } from "../boundary/process.ts";
import type { AppToolsProbeEvent } from "../bridge/app-tools-probe.ts";
import type { ToolCallProbeEvent } from "../bridge/tool-call-probe.ts";
import type { ObservationEvent } from "../rpc/observe.ts";
import type { RouteEvent } from "../rpc/route.ts";
import type { TurnEvent } from "../turn/controller.ts";

// serialize() copies only known fields, so request bodies, conversations, code and credentials cannot reach the log even through a widened object.
export type LogEvent =
  | { event: "bridge_started" }
  | { event: "bridge_startup_failed"; reason: StartupFailure }
  | { event: "log_file_unavailable"; reason: LogFileFailure }
  | { event: "server_closed" }
  | { event: "server_signaled"; signal: Signals }
  | { event: "claude_unavailable"; reason: string }
  | { event: "bridge_signaled"; signal: Signals }
  | AppToolsProbeEvent
  | ToolCallProbeEvent
  | ObservationEvent
  | TurnEvent
  | RouteEvent;

type StartupFailure = "ServerPipesUnavailable";

type LogFileFailure = "LogPathNotAbsolute" | "LogFileOpenFailed";

export type LogSink = (line: string) => void;

export const createLogger = (sink: LogSink = stderrSink) => ({
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
    case "claude_unavailable":
      return { event: entry.event, reason: entry.reason };
    case "claude_turn":
      return { event: entry.event, step: entry.step, detail: entry.detail };
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
    case "app_tools_probe":
      return {
        event: entry.event,
        via: entry.via,
        attempt: entry.attempt,
        pid: entry.pid,
        ppid: entry.ppid,
        socketExists: entry.socketExists,
        connected: entry.connected,
        sent: entry.sent,
        stage: entry.stage,
        errorCode: entry.errorCode,
        tools: [...entry.tools],
      };
    case "tool_call_probe":
      return {
        event: entry.event,
        step: entry.step,
        role: entry.role,
        detail: entry.detail,
      };
    case "rpc_unobserved":
      return {
        event: entry.event,
        direction: entry.direction,
        reason: entry.reason,
      };
  }
};

const stderrSink: LogSink = (line) => {
  process.stderr.write(line);
};
