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
      event: "bridge_started",
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

  test("keeps the thread open summary of an observed message", () => {
    const [record] = logged({
      event: "rpc_message",
      direction: "app_to_server",
      kind: "request",
      method: "thread/fork",
      id: 1,
      tools: [],
      mcpStartup: null,
      threadOpen: {
        side: "request",
        params: ["ephemeral", "threadId"],
        ephemeral: true,
        threadSource: "user",
      },
    });

    expect(record).toEqual({
      event: "rpc_message",
      direction: "app_to_server",
      kind: "request",
      method: "thread/fork",
      id: 1,
      threadOpen: {
        params: ["ephemeral", "threadId"],
        ephemeral: true,
        threadSource: "user",
      },
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
      expected: ["bridge_started"],
    },
    {
      name: "a file set by hand keeps them",
      env: () => ({ HARNEXUS_LOG_PATH: join(dir, "explicit.log") }),
      path: () => join(dir, "explicit.log"),
      expected: ["rpc_message", "bridge_started"],
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
    logger.log({ event: "bridge_started" });
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
    const { time: _time, ...record } = JSON.parse(line);
    return record;
  });
};
