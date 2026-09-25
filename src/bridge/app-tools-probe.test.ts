import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "../shared/logger.ts";
import { PROBE_ENV, startAppToolsProbe } from "./app-tools-probe.ts";

let dir: string;
let sockets = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-probe-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("startAppToolsProbe", () => {
  test("sends tools/list from the bridge, its child and its grandchild, twice", async () => {
    const socket = await fakeAppSocket("respond");
    const events = await probe({ CODEX_APP_TOOLS_PIPE_PATH: socket.path });
    socket.close();

    expect(events.map(({ via, attempt }) => `${via}#${attempt}`)).toEqual([
      "bridge#1",
      "child#1",
      "grandchild#1",
      "bridge#2",
      "child#2",
      "grandchild#2",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        connected: true,
        sent: true,
        stage: "responded",
        tools: ["codex_app.create_thread"],
      });
    }
    const [bridge, child, grandchild] = events;
    expect(bridge?.pid).toBe(process.pid);
    expect(child?.ppid).toBe(process.pid);
    expect(grandchild?.ppid).not.toBe(process.pid);
    expect(grandchild?.pid).not.toBe(child?.pid);
    expect(socket.requests()).toEqual(
      Array(6).fill({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/list",
        params: { threadStartKind: "all" },
      }),
    );
  });

  test("records how far a hung-up or missing socket got", async () => {
    const socket = await fakeAppSocket("close");
    const closed = await probe({ CODEX_APP_TOOLS_PIPE_PATH: socket.path });
    socket.close();
    const absent = await probe({
      CODEX_APP_TOOLS_PIPE_PATH: join(dir, "absent.sock"),
    });

    expect(closed).toHaveLength(6);
    for (const event of closed) {
      expect(event.socketExists).toBe(true);
      expect(["closed_before_response", "connect_failed"]).toContain(
        event.stage,
      );
      expect(event.tools).toEqual([]);
    }
    for (const event of absent) {
      expect(event).toMatchObject({
        socketExists: false,
        connected: false,
        stage: "connect_failed",
        errorCode: "ENOENT",
      });
    }
  });

  test("keeps tool names that are not plain identifiers out of the log", async () => {
    const socket = await fakeAppSocket("respond", "name with spaces");
    const events = await probe({ CODEX_APP_TOOLS_PIPE_PATH: socket.path });
    socket.close();

    expect(events[0]).toMatchObject({ stage: "responded", tools: [] });
  });

  test("reports a missing socket and stays off unless enabled", async () => {
    const missing = await probe({});
    const off: LogEvent[] = [];
    await startAppToolsProbe({ PATH: process.env.PATH }, (e) => off.push(e));

    expect(missing).toEqual([
      expect.objectContaining({ via: "bridge", stage: "pipe_missing" }),
    ]);
    expect(off).toEqual([]);
  });
});

const probe = async (env: Record<string, string>) => {
  const events: LogEvent[] = [];
  await startAppToolsProbe(
    { PATH: process.env.PATH, [PROBE_ENV]: "1", ...env },
    (entry) => events.push(entry),
    { delayMs: 10 },
  );
  return events.flatMap((entry) =>
    entry.event === "app_tools_probe" ? [entry] : [],
  );
};

const fakeAppSocket = async (
  mode: "respond" | "close",
  toolName = "create_thread",
) => {
  const path = join(dir, `app-${sockets++}.sock`);
  const received: unknown[] = [];
  const server = net.createServer((connection) => {
    if (mode === "close") {
      connection.destroy();
      return;
    }
    let pending = Buffer.alloc(0);
    connection.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const length = pending.readUInt32LE(0);
      if (pending.length < 4 + length) return;
      const request = JSON.parse(pending.subarray(4, 4 + length).toString());
      received.push(request);
      const payload = Buffer.from(
        JSON.stringify({
          id: request.id,
          jsonrpc: "2.0",
          result: { tools: [{ name: toolName, namespace: "codex_app" }] },
        }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length, 0);
      connection.write(Buffer.concat([header, payload]));
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, requests: () => received, close: () => server.close() };
};
