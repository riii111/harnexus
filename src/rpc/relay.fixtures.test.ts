import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createLogger } from "../shared/logger.ts";
import { createObserver } from "./observe.ts";
import { relayStreams } from "./relay.ts";

describe("relay over recorded app-server shapes", () => {
  test.each(
    FIXTURES,
  )("passes $name through both directions unchanged and logs every message", async ({
    name,
  }) => {
    const path = join(FIXTURE_DIR, name);
    const records = readFixture(path);

    const { exitCode, output, log } = await replay(path, records);

    expect(exitCode).toBe(0);
    expect(output).toBe(wire(records, "server_to_app"));
    expect(byDirection(log.map(summary))).toEqual(
      byDirection(records.map(expectedSummary(records))),
    );
    expect(log.join("")).not.toContain(SECRET_MARKER);
  });

  test("records the dynamic tools the app passes to thread/start", async () => {
    const path = join(FIXTURE_DIR, "handshake.jsonl");
    const { log } = await replay(path, readFixture(path));

    const threadStart = log
      .map((line) => JSON.parse(line))
      .find((record) => record.method === "thread/start" && record.tools);
    expect(threadStart.tools).toEqual([
      {
        name: "fixture_echo",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ]);
  });
});

const FIXTURE_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "test",
  "fixtures",
  "app-server",
);
const FIXTURES = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => ({ name }));
const DIRECTIONS = ["app_to_server", "server_to_app"] as const;
const REPLAY_SERVER = join(import.meta.dir, "testing", "replay-app-server.ts");
const SECRET_MARKER = "sk-fixture-secret";
const CHUNK_BYTES = 7;

// The app answers a server request only after receiving it, so this order is kept; otherwise the observer could not pair a response with its request method.
const replay = async (path: string, records: FixtureRecord[]) => {
  const log: string[] = [];
  const output = collector();
  const input = new PassThrough();
  const server = spawn(process.execPath, [REPLAY_SERVER, path], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = once(server, "close");
  const relaying = relayStreams({
    input,
    output: output.stream,
    serverInput: server.stdin,
    serverOutput: server.stdout,
    observer: createObserver(createLogger((line) => log.push(line)).log),
  });
  let expectedBytes = 0;
  for (const record of records) {
    const line = Buffer.from(`${JSON.stringify(record.message)}\n`);
    if (record.direction === "server_to_app") {
      expectedBytes += line.length;
      continue;
    }
    await Promise.race([output.reached(expectedBytes), relaying]);
    for (const chunk of split(line, CHUNK_BYTES)) input.write(chunk);
  }
  input.end();
  await relaying;
  const [exitCode] = await exited;
  return { exitCode, output: output.text(), log };
};

// Bytes are kept until the end so a multi-byte character split across writes decodes correctly.
const collector = () => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const waiters: (() => void)[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      bytes += chunk.length;
      for (const wake of waiters.splice(0)) wake();
      callback();
    },
  });
  const reached = async (length: number) => {
    while (bytes < length) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return {
    stream,
    reached,
    text: () => Buffer.concat(chunks).toString(),
  };
};

const readFixture = (path: string): FixtureRecord[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

const wire = (records: FixtureRecord[], direction: Direction) =>
  records
    .filter((record) => record.direction === direction)
    .map((record) => `${JSON.stringify(record.message)}\n`)
    .join("");

const summary = (line: string) => {
  const { direction, kind, method, id } = JSON.parse(line);
  return { direction, kind, method, id };
};

// The two directions interleave by arrival time, so each is compared on its own.
const byDirection = <T extends { direction: Direction }>(entries: T[]) =>
  Object.fromEntries(
    DIRECTIONS.map((direction) => [
      direction,
      entries.filter((entry) => entry.direction === direction),
    ]),
  );

const expectedSummary =
  (records: FixtureRecord[]) =>
  ({ direction, message }: FixtureRecord) => {
    const id = message.id ?? null;
    if (message.method !== undefined) {
      return {
        direction,
        kind: id === null ? "notification" : "request",
        method: message.method,
        id,
      };
    }
    const request = records.find(
      (record) =>
        record.direction !== direction &&
        record.message.id === id &&
        record.message.method !== undefined,
    );
    return {
      direction,
      kind: "error" in message ? "error_response" : "response",
      method: request?.message.method ?? null,
      id,
    };
  };

const split = (bytes: Buffer, size: number) =>
  Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) =>
    bytes.subarray(i * size, (i + 1) * size),
  );

type Direction = (typeof DIRECTIONS)[number];

type FixtureRecord = {
  direction: Direction;
  message: { id?: string | number; method?: string; error?: unknown };
};
