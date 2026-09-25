import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { createLogger } from "../shared/logger.ts";
import { createObserver } from "./observe.ts";
import { runRelay } from "./relay.ts";

let dir: string;
let fakeCodex: string;
let pidFiles = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-relay-"));
  fakeCodex = join(dir, "codex");
  await writeFile(
    fakeCodex,
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVER}" "$@"\n`,
  );
  await chmod(fakeCodex, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runRelay", () => {
  test("relays bytes unchanged and logs only summaries", async () => {
    const output = collector();
    const log: string[] = [];
    const logger = createLogger((line) => log.push(line));

    const result = await runRelay(fakeCodex, ["echo"], process.env, {
      input: Readable.from(FIXED_CHUNKS),
      output: output.stream,
      observer: createObserver(logger.log, { maxLineBytes: 64 * 1024 }),
    });

    expect(result.isOk() && result.value).toEqual({ code: 0, signal: null });
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
    // A high-water mark above the total lets the child finish while most writes are still pending.
    const output = collector({ delayMs: 5, highWaterMark: 64 * 1024 * 1024 });

    const result = await runRelay(fakeCodex, ["echo"], process.env, {
      input: Readable.from(chunks),
      output: output.stream,
    });

    expect(result.isOk() && result.value).toEqual({ code: 0, signal: null });
    expect(output.bytes().equals(Buffer.concat(chunks))).toBe(true);
  });

  test("returns an error when the server cannot be started", async () => {
    const result = await runRelay(join(dir, "missing"), [], process.env, {
      input: Readable.from([]),
      output: collector().stream,
    });

    expect(result.isErr() && result.error._tag).toBe("ChildSpawnFailed");
  });

  test("returns the exit code when the server crashes", async () => {
    const pidFile = nextPidFile();
    const input = new Readable({ read() {} });

    const pending = runRelay(fakeCodex, ["crash", pidFile], process.env, {
      input,
      output: collector().stream,
    });
    input.push('{"method":"initialized"}\n');

    const result = await pending;
    expect(result.isOk() && result.value).toEqual({ code: 3, signal: null });
    expect(isAlive(await readPid(pidFile))).toBe(false);
  });

  test("stops a server that closes stdout while the app stays connected", async () => {
    // Bun keeps fd 1 open on closeSync(1), so a shell closes it; exec keeps the pid and ignores stdin EOF until SIGTERM.
    const server = join(dir, "close-stdout");
    await writeFile(
      server,
      '#!/bin/sh\nexec 1>&-\necho $$ > "$1"\nexec sleep 60\n',
    );
    await chmod(server, 0o755);
    const pidFile = nextPidFile();
    const pending = runRelay(server, [pidFile], process.env, {
      input: new Readable({ read() {} }),
      output: collector().stream,
      shutdownGraceMs: 100,
    });
    const pid = await readPid(pidFile);

    const result = await pending;
    expect(result.isOk() && result.value).toEqual({
      code: null,
      signal: "SIGTERM",
    });
    expect(isAlive(pid)).toBe(false);
  });

  for (const [mode, signal] of [
    ["ignore-eof", "SIGTERM"],
    ["ignore-term", "SIGKILL"],
  ] as const) {
    test(`ends a server that survives the app disconnecting with ${signal}`, async () => {
      const pidFile = nextPidFile();
      const input = new Readable({ read() {} });
      const pending = runRelay(fakeCodex, [mode, pidFile], process.env, {
        input,
        output: collector().stream,
        shutdownGraceMs: 100,
      });
      const pid = await readPid(pidFile);

      input.push(null);

      const result = await pending;
      expect(result.isOk() && result.value).toEqual({ code: null, signal });
      expect(isAlive(pid)).toBe(false);
    });
  }
});

describe("bridge process", () => {
  test("exits with the server when the app closes stdin", async () => {
    const { bridge, serverPid } = startBridge("echo");
    const pid = await serverPid();
    bridge.stdin.write('{"id":1,"method":"initialize"}\n');
    bridge.stdin.end();

    expect(await bridge.exited).toBe(0);
    expect(await new Response(bridge.stdout).text()).toBe(
      '{"id":1,"method":"initialize"}\n',
    );
    expect(isAlive(pid)).toBe(false);
  });

  test("stops the server when the app stops reading output", async () => {
    // Bun.spawn's stdout.cancel() leaves the pipe open, so node:child_process closes it to make the next write fail with EPIPE.
    const pidFile = nextPidFile();
    const bridge = spawn(process.execPath, [BRIDGE, "echo", pidFile], {
      env: { ...process.env, HARNEXUS_CODEX_PATH: fakeCodex },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const exited = once(bridge, "exit");
    const pid = await readPid(pidFile);
    bridge.stdout.destroy();
    bridge.stdin.write('{"id":1,"method":"initialize"}\n');

    await exited;
    expect(isAlive(pid)).toBe(false);
  });

  test("exits when the server exits abnormally", async () => {
    const { bridge, serverPid } = startBridge("crash");
    const pid = await serverPid();
    bridge.stdin.write('{"method":"initialized"}\n');

    expect(await bridge.exited).toBe(3);
    expect(isAlive(pid)).toBe(false);
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`forwards ${signal} to the server and ends with it`, async () => {
      const { bridge, serverPid } = startBridge("ignore-eof");
      const pid = await serverPid();

      bridge.kill(signal);
      await bridge.exited;

      expect(bridge.signalCode).toBe(signal);
      expect(isAlive(pid)).toBe(false);
    });
  }
});

const FAKE_SERVER = join(import.meta.dir, "testing", "fake-app-server.ts");
const BRIDGE = join(import.meta.dir, "..", "bridge", "main.ts");
const SECRET = "sk-secret-token-0123";

const startBridge = (mode: string) => {
  const pidFile = nextPidFile();
  const bridge = Bun.spawn([process.execPath, BRIDGE, mode, pidFile], {
    env: { ...process.env, HARNEXUS_CODEX_PATH: fakeCodex },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  return { bridge, serverPid: () => readPid(pidFile) };
};

// Bytes are recorded only when a write completes, so a delayed output shows whether the relay finished before its data arrived.
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

const nextPidFile = () => join(dir, `server-${pidFiles++}.pid`);

const readPid = async (pidFile: string) => {
  let pid = 0;
  await waitFor(async () => {
    const file = Bun.file(pidFile);
    pid = (await file.exists()) ? Number(await file.text()) : 0;
    return pid > 0;
  });
  return pid;
};

const waitFor = async (check: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  expect.unreachable("condition was not met in time");
};

// kill(1) reports a missing process through its exit status, where process.kill would throw.
const isAlive = (pid: number) =>
  Bun.spawnSync(["kill", "-0", String(pid)], { stderr: "ignore" }).exitCode ===
  0;

// Split and joined lines, invalid JSON, non-UTF-8 bytes, a line over the limit and a final line without a newline.
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
