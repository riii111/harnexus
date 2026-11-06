import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let server: Server | null;

beforeEach(async () => {
  // The real path, since the command reports the directory it runs in as the system resolves it.
  dir = await realpath(await mkdtemp(join(tmpdir(), "harnexus-cli-")));
  server = null;
});

afterEach(async () => {
  server?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("harnexus call", () => {
  test("asks for protocol 1 first, then sends the call with the caller's thread", async () => {
    const received = await fakeBridge((line) =>
      isQuery(line)
        ? CAPABILITIES
        : JSON.stringify({ version: 1, outcome: "done", result: {} }),
    );

    const run = await harnexus(["call"], {
      stdin: JSON.stringify({
        tool: "read_thread",
        arguments: { threadId: "t" },
      }),
    });

    expect(received).toEqual([
      { version: 1, query: "capabilities" },
      {
        version: 1,
        threadId: CALLER,
        tool: "read_thread",
        arguments: { threadId: "t" },
      },
    ]);
    expect(JSON.parse(run.stdout)).toEqual({
      version: 1,
      outcome: "done",
      result: {},
    });
    expect(run.code).toBe(0);
  });

  test("stops before sending when an older bridge answers the query as invalid", async () => {
    const received = await fakeBridge(() =>
      JSON.stringify({
        outcome: "invalid",
        message: "expected {threadId,tool,arguments}",
      }),
    );

    const run = await harnexus(["call"], {
      stdin: JSON.stringify({ tool: "send_message_to_thread", arguments: {} }),
    });

    expect(received).toEqual([{ version: 1, query: "capabilities" }]);
    expect(JSON.parse(run.stdout).outcome).toBe("unsupported");
    expect(run.code).toBe(8);
  });

  test("names a call the bridge never received as not sent", async () => {
    const run = await harnexus(["call"], {
      stdin: JSON.stringify({ tool: "read_thread" }),
    });

    expect(JSON.parse(run.stdout).outcome).toBe("not_sent");
    expect(run.code).toBe(2);
  });

  test("names a call whose answer was lost after it was sent as unknown", async () => {
    const received = await fakeBridge((line) =>
      isQuery(line) ? CAPABILITIES : null,
    );

    const run = await harnexus(["call"], {
      stdin: JSON.stringify({ tool: "send_message_to_thread", arguments: {} }),
    });

    expect(received).toHaveLength(2);
    expect(JSON.parse(run.stdout).outcome).toBe("unknown");
    expect(run.code).toBe(3);
  });

  test("names the call socket being off as not sent, without connecting", async () => {
    const run = await harnexus(["call"], {
      stdin: JSON.stringify({ tool: "read_thread" }),
      env: { HARNEXUS_CALL_SOCKET: "off" },
    });

    expect(run.stderr).toContain("HARNEXUS_CALL_SOCKET=off");
    expect(run.code).toBe(2);
  });
});

describe("harnexus cloud", () => {
  test("opens a chat for a session and prints it as harnexus-task cloud did", async () => {
    const opened = {
      threadId: "th-cloud",
      cloudSessionId: SESSION,
      url: `https://claude.ai/code/${SESSION}`,
    };
    const received = await fakeBridge((line) =>
      isQuery(line)
        ? CAPABILITIES
        : JSON.stringify({ version: 1, outcome: "done", result: opened }),
    );

    const run = await harnexus([
      "cloud",
      "--link",
      SESSION,
      "--title",
      "README",
    ]);

    expect(received[1]).toEqual({
      version: 1,
      threadId: CALLER,
      tool: "cloud_open",
      arguments: { cwd: dir, link: SESSION, title: "README" },
    });
    expect(JSON.parse(run.stdout)).toEqual(opened);
    expect(run.code).toBe(0);
  });

  test("sends a prompt file's text to start a session", async () => {
    const received = await fakeBridge((line) =>
      isQuery(line)
        ? CAPABILITIES
        : JSON.stringify({ version: 1, outcome: "unknown", message: "lost" }),
    );
    const prompt = join(dir, "prompt.md");
    await writeFile(prompt, "fix the typo\n");

    const run = await harnexus(["cloud", "--prompt-file", prompt]);

    expect((received[1] as { arguments: unknown }).arguments).toEqual({
      cwd: dir,
      prompt: "fix the typo\n",
    });
    expect(run.stderr).toBe("harnexus cloud: unknown: lost\n");
    expect(run.code).toBe(3);
  });

  test("refuses both a link and a prompt file before connecting", async () => {
    const run = await harnexus([
      "cloud",
      "--link",
      SESSION,
      "--prompt-file",
      "p",
    ]);

    expect(run.stderr).toContain("exactly one of --link and --prompt-file");
    expect(run.code).toBe(5);
  });
});

const CALLER = "th-caller";
const SESSION = "session_01NfjPqrX1AK5RmKyV182VYD";
const CAPABILITIES = JSON.stringify({
  version: 1,
  outcome: "done",
  operations: ["read_thread", "send_message_to_thread", "cloud_open"],
});

const isQuery = (line: string) => line.includes('"query"');

// A bridge that answers each line with the given text, or drops the connection unanswered when it gives null.
const fakeBridge = async (answer: (line: string) => string | null) => {
  const received: unknown[] = [];
  server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      const line = buffer.slice(0, end);
      received.push(JSON.parse(line));
      const text = answer(line);
      if (text === null) socket.destroy();
      else socket.end(`${text}\n`);
    });
  });
  await new Promise<void>((resolve) => server?.listen(socketPath(), resolve));
  return received;
};

const socketPath = () => join(dir, "call.sock");

const harnexus = async (
  argv: readonly string[],
  {
    stdin = "",
    env = {},
  }: { stdin?: string; env?: Record<string, string> } = {},
) => {
  const child = Bun.spawn([process.execPath, ENTRY, ...argv], {
    cwd: dir,
    env: {
      ...process.env,
      CODEX_THREAD_ID: CALLER,
      HARNEXUS_CALL_SOCKET: socketPath(),
      ...env,
    },
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};

const ENTRY = join(import.meta.dir, "harnexus.ts");
