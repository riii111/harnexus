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
      appInput: Readable.from(FIXED_CHUNKS),
      appOutput: output.stream,
      serverInput: echo,
      serverOutput: echo,
      stopServer: IGNORE_SIGNALS,
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

  test("hands every byte to a slow output before completing", async () => {
    const chunks = Array.from({ length: 64 }, (_, i) =>
      Buffer.alloc(16 * 1024, i),
    );
    // A high-water mark above the total lets the server finish while most writes are still pending.
    const output = collector({ delayMs: 5, highWaterMark: 64 * 1024 * 1024 });
    const echo = new PassThrough();

    await relayStreams({
      appInput: Readable.from(chunks),
      appOutput: output.stream,
      serverInput: echo,
      serverOutput: echo,
      stopServer: IGNORE_SIGNALS,
    });

    expect(output.bytes().equals(Buffer.concat(chunks))).toBe(true);
  });

  test("relays both ways and ends once the server output has reached the app", async () => {
    const output = collector({ delayMs: 5 });
    const serverInput = collector();
    const serverOutput = new PassThrough();
    const input = new PassThrough();

    const relaying = relayStreams({
      appInput: input,
      appOutput: output.stream,
      serverInput: serverInput.stream,
      serverOutput,
      stopServer: IGNORE_SIGNALS,
    });
    input.end("to server\n");
    serverOutput.end("to app\n");
    await relaying;

    expect(output.bytes().toString()).toBe("to app\n");
    expect(serverInput.bytes().toString()).toBe("to server\n");
  });

  test("ends the server input when the app disconnects", async () => {
    const serverInput = collector();
    const serverOutput = new PassThrough();
    const input = new PassThrough();

    const relaying = relayStreams({
      appInput: input,
      appOutput: collector().stream,
      serverInput: serverInput.stream,
      serverOutput,
      stopServer: IGNORE_SIGNALS,
    });
    input.end();
    await once(serverInput.stream, "finish");
    serverOutput.end();
    await relaying;

    expect(serverInput.stream.writableFinished).toBe(true);
  });

  test("signals a server that outlives the app with SIGTERM, then SIGKILL", async () => {
    const signals: string[] = [];
    const serverOutput = new PassThrough();
    const input = new PassThrough();

    const relaying = relayStreams({
      appInput: input,
      appOutput: collector().stream,
      serverInput: collector().stream,
      serverOutput,
      stopServer: { signal: (signal) => signals.push(signal), graceMs: 20 },
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
      appInput: new PassThrough(),
      appOutput: collector().stream,
      serverInput: injector.stream,
      serverOutput,
      stopServer: { signal: (signal) => signals.push(signal), graceMs: 20 },
    });
    injector.inject("own\n");
    await Bun.sleep(120);
    serverOutput.end();
    await relaying;

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("sends no signal when the server exits within the grace period", async () => {
    const signals: string[] = [];
    const serverOutput = new PassThrough();
    const input = new PassThrough();

    const relaying = relayStreams({
      appInput: input,
      appOutput: collector().stream,
      serverInput: collector().stream,
      serverOutput,
      stopServer: { signal: (signal) => signals.push(signal), graceMs: 50 },
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
    const broken = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("EPIPE"));
      },
    });
    broken.on("error", () => {});

    const relaying = relayStreams({
      appInput: new PassThrough(),
      appOutput: broken,
      serverInput: serverInput.stream,
      serverOutput,
      stopServer: IGNORE_SIGNALS,
    });
    serverOutput.write("lost\n");
    await once(serverInput.stream, "finish");
    serverOutput.end();
    await relaying;

    expect(serverInput.stream.writableFinished).toBe(true);
  });
});

const SECRET = "sk-secret-token-0123";

const IGNORE_SIGNALS = { signal: () => {}, graceMs: 5000 };

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
