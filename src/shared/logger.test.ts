import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createLogger, type LogEvent } from "./logger.ts";

const stdoutWrite = spyOn(process.stdout, "write");

afterEach(() => {
  stdoutWrite.mockClear();
});

describe("createLogger", () => {
  test("writes one JSON line per event to the sink", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    logger.log({ event: "server_signaled", signal: "SIGTERM" });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      event: "server_signaled",
      signal: "SIGTERM",
    });
  });

  test("records a failed server signal with its errno code", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    logger.log({
      event: "server_signal_failed",
      signal: "SIGKILL",
      code: "EPERM",
    });

    const { time: _time, ...record } = JSON.parse(lines[0] ?? "");
    expect(record).toEqual({
      event: "server_signal_failed",
      signal: "SIGKILL",
      code: "EPERM",
    });
  });

  test("drops fields outside the event shape", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    const entry = {
      event: "bridge_started",
      params: { token: "secret-token", prompt: "private text" },
    } as const;
    const widened: LogEvent = entry;

    logger.log(widened);

    expect(lines.join("")).not.toContain("secret-token");
    expect(lines.join("")).not.toContain("private text");
  });

  test("keeps only the summary fields of an observed message", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    const entry = {
      event: "rpc_message",
      direction: "app_to_server",
      kind: "request",
      method: "turn/start",
      id: 1,
      tools: [{ name: "t", inputSchema: true, description: "private text" }],
      mcpStartup: null,
      params: { token: "secret-token" },
    } as const;
    const widened: LogEvent = entry;

    logger.log(widened);

    const { time: _time, ...record } = JSON.parse(lines[0] ?? "");
    expect(record).toEqual({
      event: "rpc_message",
      direction: "app_to_server",
      kind: "request",
      method: "turn/start",
      id: 1,
      tools: [{ name: "t", inputSchema: true }],
    });
  });

  test("defaults to stderr and never writes to stdout", () => {
    const stderrWrite = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );

    createLogger().log({ event: "bridge_started" });

    expect(stderrWrite).toHaveBeenCalledTimes(1);
    expect(stdoutWrite).not.toHaveBeenCalled();
    stderrWrite.mockRestore();
  });
});
