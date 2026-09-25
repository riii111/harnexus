import type { Signals } from "../boundary/process.ts";
import type { ObservationEvent } from "../rpc/observe.ts";

// serialize() copies only known fields, so request bodies, conversations, code and credentials cannot reach the log even through a widened object.
export type LogEvent =
  | { event: "bridge_started" }
  | { event: "bridge_startup_failed"; reason: StartupFailure }
  | { event: "log_file_unavailable"; reason: LogFileFailure }
  | { event: "server_closed" }
  | { event: "server_signaled"; signal: Signals }
  | ObservationEvent;

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
      return { event: entry.event, signal: entry.signal };
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

const stderrSink: LogSink = (line) => {
  process.stderr.write(line);
};
