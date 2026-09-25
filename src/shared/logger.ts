import type { Signals } from "../boundary/process.ts";
import type { ObservationEvent } from "../rpc/observe.ts";

// serialize() copies only known fields, so request bodies, conversations, code and credentials cannot reach the log even through a widened object.
export type LogEvent =
  | { event: "bridge_started" }
  | { event: "bridge_startup_failed"; reason: StartupFailure }
  | { event: "codex_exited"; code: number | null; signal: Signals | null }
  | ObservationEvent;

type StartupFailure =
  | "CodexPathMissing"
  | "CodexPathNotAbsolute"
  | "FileNotExecutable"
  | "ChildSpawnFailed";

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
      return { event: entry.event };
    case "bridge_startup_failed":
      return { event: entry.event, reason: entry.reason };
    case "codex_exited":
      return { event: entry.event, code: entry.code, signal: entry.signal };
    case "rpc_message":
      return {
        event: entry.event,
        direction: entry.direction,
        kind: entry.kind,
        method: entry.method,
        id: entry.id,
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
