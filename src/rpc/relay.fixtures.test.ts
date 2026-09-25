import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createLogger } from "../shared/logger.ts";
import { createObserver } from "./observe.ts";
import { runRelay } from "./relay.ts";

let dir: string;
let replayServer: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-fixtures-"));
  replayServer = join(dir, "codex");
  await writeFile(
    replayServer,
    `#!/bin/sh\nexec "${process.execPath}" "${REPLAY_SERVER}" "$@"\n`,
  );
  await chmod(replayServer, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("relay over recorded app-server shapes", () => {
  for (const name of FIXTURES) {
    test(`${name} passes both directions unchanged and logs every message`, async () => {
      const path = join(FIXTURE_DIR, name);
      const records = readFixture(path);
      const { result, output, log } = await replay(path, records);

      expect(result.isOk() && result.value).toEqual({ code: 0, signal: null });
      expect(output).toBe(wire(records, "server_to_app"));
      for (const direction of DIRECTIONS) {
        expect(
          log.map(summary).filter((entry) => entry.direction === direction),
        ).toEqual(
          records
            .filter((record) => record.direction === direction)
            .map(expectedSummary(records)),
        );
      }
      expect(log.join("")).not.toContain(SECRET_MARKER);
    });
  }

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
const FIXTURES = readdirSync(FIXTURE_DIR).filter((name) =>
  name.endsWith(".jsonl"),
);
const DIRECTIONS = ["app_to_server", "server_to_app"] as const;
const REPLAY_SERVER = join(import.meta.dir, "testing", "replay-app-server.ts");
const SECRET_MARKER = "sk-fixture-secret";
const CHUNK_BYTES = 7;

// Like the app, each app line is sent only after the server lines before it have come out, and it is cut into small chunks so it crosses read boundaries in the relay.
const replay = async (path: string, records: FixtureRecord[]) => {
  const log: string[] = [];
  const output = collector();
  const input = new PassThrough();
  const relaying = runRelay(replayServer, [path], process.env, {
    input,
    output: output.stream,
    observer: createObserver(createLogger((line) => log.push(line)).log),
  });
  let expected = "";
  for (const record of records) {
    const line = `${JSON.stringify(record.message)}\n`;
    if (record.direction === "server_to_app") {
      expected += line;
      continue;
    }
    await output.reached(expected.length);
    for (const chunk of split(Buffer.from(line), CHUNK_BYTES)) {
      input.write(chunk);
    }
  }
  input.end();
  const result = await relaying;
  return { result, output: output.text(), log };
};

const collector = () => {
  let text = "";
  const waiters: (() => void)[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += Buffer.from(chunk).toString();
      for (const wake of waiters.splice(0)) wake();
      callback();
    },
  });
  const reached = async (length: number) => {
    while (text.length < length) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { stream, reached, text: () => text };
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

// Log lines of the two directions interleave by arrival time, so each direction is compared on its own; a response is labeled with the method of the request it answers, which was sent in the other direction.
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
