import { describe, expect, spyOn, test } from "bun:test";
import { createBridgeLogger } from "./logging.ts";

describe("createBridgeLogger", () => {
  test("records a server signal with only its signal", () => {
    const [record] = logged({ event: "server_signaled", signal: "SIGTERM" });

    expect(record).toEqual({ event: "server_signaled", signal: "SIGTERM" });
  });

  test("records a failed server signal with its errno code", () => {
    const [record] = logged({
      event: "server_signal_failed",
      signal: "SIGKILL",
      code: "EPERM",
    });

    expect(record).toEqual({
      event: "server_signal_failed",
      signal: "SIGKILL",
      code: "EPERM",
    });
  });

  test("drops fields outside the event shape", () => {
    const entry = {
      event: "bridge_started",
      params: { token: "secret-token", prompt: "private text" },
    } as const;
    const widened: LogEvent = entry;

    const log = JSON.stringify(logged(widened));

    expect(log).not.toContain("secret-token");
    expect(log).not.toContain("private text");
  });

  test("keeps only the summary fields of an observed message", () => {
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

    const [record] = logged(widened);

    expect(record).toEqual({
      event: "rpc_message",
      direction: "app_to_server",
      kind: "request",
      method: "turn/start",
      id: 1,
      tools: [{ name: "t", inputSchema: true }],
    });
  });
});

type LogEvent = Parameters<ReturnType<typeof createBridgeLogger>["log"]>[0];

// Without HARNEXUS_LOG_PATH the bridge logger writes only to stderr, so each record is read back from there without its time.
const logged = (entry: LogEvent) => {
  const lines: string[] = [];
  const write = spyOn(process.stderr, "write").mockImplementation((line) => {
    lines.push(String(line));
    return true;
  });
  createBridgeLogger({}).log(entry);
  write.mockRestore();
  return lines.map((line) => {
    const { time: _time, ...record } = JSON.parse(line);
    return record;
  });
};
