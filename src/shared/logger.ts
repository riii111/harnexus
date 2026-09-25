import type { Signals } from "../boundary/process.ts";

// Only fixed shapes can be logged, and serialize() copies known fields, so
// request bodies, conversations, code and credentials cannot reach the log.
export type StartupFailure =
  | "CodexPathMissing"
  | "CodexPathNotAbsolute"
  | "FileNotExecutable"
  | "ChildSpawnFailed";

export type LogEvent =
  | { event: "bridge_started" }
  | { event: "bridge_startup_failed"; reason: StartupFailure }
  | { event: "codex_exited"; code: number | null; signal: Signals | null };

export type LogSink = (line: string) => void;

export const stderrSink: LogSink = (line) => {
  process.stderr.write(line);
};

const serialize = (entry: LogEvent) => {
  switch (entry.event) {
    case "bridge_started":
      return { event: entry.event };
    case "bridge_startup_failed":
      return { event: entry.event, reason: entry.reason };
    case "codex_exited":
      return { event: entry.event, code: entry.code, signal: entry.signal };
  }
};

export const createLogger = (sink: LogSink = stderrSink) => ({
  log: (entry: LogEvent) => {
    const record = { time: new Date().toISOString(), ...serialize(entry) };
    sink(`${JSON.stringify(record)}\n`);
  },
});

export type Logger = ReturnType<typeof createLogger>;
