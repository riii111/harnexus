import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeLogger } from "./logging.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-logging-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createBridgeLogger", () => {
  test.each<{ name: string; entry: LogEvent; expected: object }>([
    {
      name: "a server signal with only its signal",
      entry: { event: "server_signaled", signal: "SIGTERM" },
      expected: { event: "server_signaled", signal: "SIGTERM" },
    },
    {
      name: "a failed server signal with its errno code",
      entry: {
        event: "server_signal_failed",
        signal: "SIGKILL",
        code: "EPERM",
      },
      expected: {
        event: "server_signal_failed",
        signal: "SIGKILL",
        code: "EPERM",
      },
    },
  ])("records $name", ({ entry, expected }) => {
    const [record] = logged(entry);

    expect(record).toEqual(expected);
  });

  test("drops fields outside the event shape", () => {
    const entry = {
      event: "server_closed",
      params: { token: "secret-token", prompt: "private text" },
    } as const;
    const widened: LogEvent = entry;

    const log = JSON.stringify(logged(widened));

    expect(log).not.toContain("secret-token");
    expect(log).not.toContain("private text");
  });

  test("records a turn's metrics with only its counts, durations, model, effort and whether it compacted", () => {
    const entry = {
      event: "claude_turn",
      step: "metrics",
      model: "claude-sonnet-5-5",
      effort: "high",
      compaction: true,
      totalTokens: 40,
      inputTokens: 34,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      sessionStartMs: null,
      firstMessageMs: 70,
      turnMs: 200,
      threadId: "th-secret",
      prompt: "private text",
    } as const;
    const widened: LogEvent = entry;

    const [record] = logged(widened);

    const { threadId: _threadId, prompt: _prompt, ...kept } = entry;
    expect(record).toEqual(kept);
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
      threadOpen: null,
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

describe("createBridgeLogger pid", () => {
  test("marks every line with the bridge's pid", () => {
    const lines: string[] = [];
    const write = spyOn(process.stderr, "write").mockImplementation((line) => {
      lines.push(String(line));
      return true;
    });
    createBridgeLogger({ HARNEXUS_LOG_PATH: "off" }).log({
      event: "server_closed",
    });
    write.mockRestore();

    expect(lines.map((line) => JSON.parse(line).pid)).toEqual([process.pid]);
  });
});

describe("createBridgeLogger bridge_started", () => {
  test("records the code and setting kinds without anything outside them", () => {
    const settings = {
      permissionMode: "auto",
      unverifiedCodex: "run",
      statePath: "custom",
      logPath: "default",
      callSocket: "off",
    } as const;
    const entry = {
      event: "bridge_started",
      commit: "0123456789ab",
      bun: "1.4.4",
      sdk: "0.3.304",
      claudeCode: "2.1.304",
      settings: { ...settings, path: "/Users/someone/private" },
      cwd: "/Users/someone/project",
    } as const;
    const widened: LogEvent = entry;

    const [record] = logged(widened);

    expect(record).toEqual({
      event: "bridge_started",
      commit: "0123456789ab",
      bun: "1.4.4",
      sdk: "0.3.304",
      claudeCode: "2.1.304",
      settings,
    });
  });
});

describe("createBridgeLogger file", () => {
  test.each([
    {
      name: "the default file leaves out relayed messages",
      env: () => ({
        HARNEXUS_STATE_PATH: join(dir, "default", "threads.json"),
      }),
      path: () => join(dir, "default", "bridge.log"),
      expected: ["server_closed"],
    },
    {
      name: "a file set by hand keeps them",
      env: () => ({ HARNEXUS_LOG_PATH: join(dir, "explicit.log") }),
      path: () => join(dir, "explicit.log"),
      expected: ["rpc_message", "server_closed"],
    },
  ])("$name", async ({ env, path, expected }) => {
    const write = spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createBridgeLogger(env());
    logger.log({
      event: "rpc_message",
      direction: "server_to_app",
      kind: "notification",
      method: "item/agentMessage/delta",
      id: null,
      tools: [],
      mcpStartup: null,
      threadOpen: null,
    });
    logger.log({ event: "server_closed" });
    write.mockRestore();

    const events = (await readFile(path(), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);

    expect(events).toEqual([...expected]);
  });
});

type LogEvent = Parameters<ReturnType<typeof createBridgeLogger>["log"]>[0];

// With HARNEXUS_LOG_PATH off the bridge logger writes only to stderr, so each record is read back from there without its time.
const logged = (entry: LogEvent) => {
  const lines: string[] = [];
  const write = spyOn(process.stderr, "write").mockImplementation((line) => {
    lines.push(String(line));
    return true;
  });
  createBridgeLogger({ HARNEXUS_LOG_PATH: "off" }).log(entry);
  write.mockRestore();
  return lines.map((line) => {
    const { time: _time, pid: _pid, ...record } = JSON.parse(line);
    return record;
  });
};
