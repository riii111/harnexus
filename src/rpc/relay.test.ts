import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { createLogger } from "../shared/logger.ts";
import { createLineInjector } from "./inject.ts";
import { createObserver } from "./observe.ts";
import { relayStreams } from "./relay.ts";

describe("relayStreams", () => {
  test("relays bytes unchanged and logs only summaries", async () => {
    const output = collector();
    const log: string[] = [];
    const logger = createLogger((line) => log.push(line));
    const echo = new PassThrough();

    await relayStreams({
      input: Readable.from(FIXED_CHUNKS),
      output: output.stream,
      serverInput: echo,
      serverOutput: echo,
      observer: createObserver(logger.log, { maxLineBytes: 64 * 1024 }),
    });

    expect(output.bytes().equals(Buffer.concat(FIXED_CHUNKS))).toBe(true);
    const toServer = log
      .map((line) => JSON.parse(line))
      .filter((record) => record.direction === "app_to_server");
    expect(toServer.map((record) => record.method ?? record.reason)).toEqual([
      "initialize",
      "initialized",
      "turn/start",
      "invalid_json",
      "invalid_json",
      "invalid_json",
      "too_large",
      "tail",
    ]);
    expect(log.join("")).not.toContain(SECRET);
  });

  test("holds the server output back while the app output is full and resumes on drain", async () => {
    const output = heldCollector();
    const serverOutput = new PassThrough();
    const chunks = Array.from({ length: 8 }, (_, i) =>
      Buffer.alloc(HELD_HIGH_WATER_MARK, i),
    );

    const relaying = relayStreams({
      input: new PassThrough(),
      output: output.stream,
      serverInput: collector().stream,
      serverOutput,
    });
    for (const chunk of chunks) serverOutput.write(chunk);
    await Bun.sleep(10);
    const buffered = output.stream.writableLength;
    output.release();
    serverOutput.end();
    await relaying;

    expect(buffered).toBeLessThanOrEqual(HELD_HIGH_WATER_MARK);
    expect(output.bytes().equals(Buffer.concat(chunks))).toBe(true);
  });

  test("hands every byte to a slow output before completing", async () => {
    const chunks = Array.from({ length: 64 }, (_, i) =>
      Buffer.alloc(16 * 1024, i),
    );
    // A high-water mark above the total lets the server finish while most writes are still pending.
    const output = collector({ delayMs: 5, highWaterMark: 64 * 1024 * 1024 });
    const echo = new PassThrough();

    await relayStreams({
      input: Readable.from(chunks),
      output: output.stream,
      serverInput: echo,
      serverOutput: echo,
    });

    expect(output.bytes().equals(Buffer.concat(chunks))).toBe(true);
  });

  test("relays both ways and ends once the server output has reached the app", async () => {
    const output = collector({ delayMs: 5 });
    const serverInput = collector();
    const serverOutput = new PassThrough();
    const input = new PassThrough();

    const relaying = relayStreams({
      input,
      output: output.stream,
      serverInput: serverInput.stream,
      serverOutput,
    });
    input.end("to server\n");
    serverOutput.end("to app\n");
    await relaying;

    expect(output.bytes().toString()).toBe("to app\n");
    expect(serverInput.bytes().toString()).toBe("to server\n");
  });

  test("signals a server that outlives the app with SIGTERM, then SIGKILL", async () => {
    const signals: string[] = [];
    const serverOutput = new PassThrough();
    const input = new PassThrough();

    const relaying = relayStreams({
      input,
      output: collector().stream,
      serverInput: collector().stream,
      serverOutput,
      signalServer: (signal) => signals.push(signal),
      shutdownGraceMs: 20,
    });
    input.end();
    await Bun.sleep(100);
    serverOutput.end();
    await relaying;

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("starts stopping the server when an injected write fails while its output stays open", async () => {
    const signals: string[] = [];
    const serverOutput = new PassThrough();
    const injector = createLineInjector(
      new Writable({
        write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
        },
      }),
    );

    const relaying = relayStreams({
      input: new PassThrough(),
      output: collector().stream,
      serverInput: injector.stream,
      serverOutput,
      signalServer: (signal) => signals.push(signal),
      shutdownGraceMs: 5,
    });
    injector.inject("own\n");
    await Bun.sleep(40);
    serverOutput.end();
    await relaying;

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("sends no signal when the server exits within the grace period", async () => {
    const signals: string[] = [];
    const serverOutput = new PassThrough();
    const input = new PassThrough();

    const relaying = relayStreams({
      input,
      output: collector().stream,
      serverInput: collector().stream,
      serverOutput,
      signalServer: (signal) => signals.push(signal),
      shutdownGraceMs: 50,
    });
    input.end();
    serverOutput.end();
    await relaying;
    await Bun.sleep(150);

    expect(signals).toEqual([]);
  });

  test("ends the server input when the app stops reading output", async () => {
    const serverInput = collector();
    const serverOutput = new PassThrough();

    const relaying = relayStreams({
      input: new PassThrough(),
      output: silentlyBroken(),
      serverInput: serverInput.stream,
      serverOutput,
    });
    serverOutput.write("lost\n");
    await once(serverInput.stream, "finish");
    serverOutput.end();
    await relaying;

    expect(serverInput.stream.writableFinished).toBe(true);
  });
});

const SECRET = "sk-secret-token-0123";

const collector = ({ delayMs = 0, highWaterMark = 16 * 1024 } = {}) => {
  const chunks: Uint8Array[] = [];
  const stream = new Writable({
    highWaterMark,
    write(chunk: Uint8Array, _encoding, callback) {
      const complete = () => {
        chunks.push(chunk);
        callback();
      };
      if (delayMs === 0) complete();
      else setTimeout(complete, delayMs);
    },
  });
  return { stream, bytes: () => Buffer.concat(chunks) };
};

const HELD_HIGH_WATER_MARK = 16 * 1024;

// Completes no write until released, like an app that has stopped reading for a while.
const heldCollector = () => {
  const chunks: Uint8Array[] = [];
  const held: (() => void)[] = [];
  let released = false;
  const stream = new Writable({
    highWaterMark: HELD_HIGH_WATER_MARK,
    write(chunk: Uint8Array, _encoding, callback) {
      const complete = () => {
        chunks.push(chunk);
        callback();
      };
      if (released) complete();
      else held.push(complete);
    },
  });
  const release = () => {
    released = true;
    for (const complete of held.splice(0)) complete();
  };
  return { stream, release, bytes: () => Buffer.concat(chunks) };
};

// Fails writes only through their callbacks, as Bun's process.stdout does on EPIPE without emitting "error".
const silentlyBroken = () =>
  Object.assign(new Writable({ write: (_chunk, _encoding, done) => done() }), {
    write: (_chunk: Uint8Array, callback?: (error?: Error | null) => void) => {
      queueMicrotask(() => callback?.(new Error("EPIPE")));
      return true;
    },
  });

const FIXED_CHUNKS = [
  Buffer.from('{"id":1,"method":"initialize","params":{"clientInfo":'),
  Buffer.from('{"name":"app"}}}\n{"method":"initialized"}\n'),
  Buffer.from(
    `{"id":2,"method":"turn/start","params":{"token":"${SECRET}"}}\n`,
  ),
  Buffer.from(`not json ${SECRET}\n`),
  Buffer.from([0xff, 0xfe, 0x0a, 0x7b, 0x0d, 0x0a]),
  Buffer.from(
    `{"id":3,"method":"x","params":{"blob":"${"a".repeat(1 << 20)}"}}\n`,
  ),
  Buffer.from('{"id":4,"method":"tail"}'),
];
