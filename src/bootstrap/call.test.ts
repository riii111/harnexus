import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveLines } from "../runtime/socket.boundary.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-call-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("harnexus call", () => {
  test("prints the bridge's model_mismatch answer and exits with 6", async () => {
    const path = join(dir, "call.sock");
    const received: string[] = [];
    const served = await serveLines(path, async (line) => {
      received.push(line);
      return MISMATCH;
    });
    if (served.isErr()) return expect.unreachable(served.error.message);

    const call = Bun.spawn([process.execPath, CALL], {
      env: { ...process.env, HARNEXUS_CALL_SOCKET: path },
      stdin: new Blob([REQUEST]),
      stdout: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(call.stdout).text(),
      call.exited,
    ]);
    served.value.close();

    expect(received).toEqual([REQUEST]);
    expect(stdout).toBe(`${MISMATCH}\n`);
    expect(exitCode).toBe(6);
  });
});

const CALL = join(import.meta.dir, "call.ts");
const REQUEST = JSON.stringify({
  threadId: "th-codex",
  tool: "create_thread",
  arguments: { prompt: "work", model: "gpt-worker", thinking: "low" },
});
const MISMATCH = JSON.stringify({
  outcome: "model_mismatch",
  threadId: "th-worker",
  expected: { model: "gpt-worker", effort: "low" },
  actual: { model: "gpt-other", effort: "low" },
});
