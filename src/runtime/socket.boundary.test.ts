import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestLine, serveLines } from "./socket.boundary.ts";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "harnexus-socket-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("serveLines", () => {
  test("answers each request line with the handler's line", async () => {
    const path = join(directory, "call.sock");
    const served = await serveLines(path, async (line) => `got ${line}`);

    const answer = await requestLine(path, '{"a":1}', 1000);

    expect(answer.isOk() && answer.value).toBe('got {"a":1}');
    if (served.isOk()) served.value.close();
  });

  test("keeps a socket another bridge is serving", async () => {
    const path = join(directory, "call.sock");
    const first = await serveLines(path, async () => "first");

    const second = await serveLines(path, async () => "second");
    const answer = await requestLine(path, "x", 1000);

    expect(second.isErr() && second.error._tag).toBe("SocketInUse");
    expect(answer.isOk() && answer.value).toBe("first");
    if (first.isOk()) first.value.close();
  });

  test("replaces a file nobody serves", async () => {
    const path = join(directory, "call.sock");
    await writeFile(path, "");

    const served = await serveLines(path, async () => "fresh");
    const answer = await requestLine(path, "x", 1000);

    expect(answer.isOk() && answer.value).toBe("fresh");
    if (served.isOk()) served.value.close();
  });
});

describe("requestLine", () => {
  test("reports a missing socket with its code", async () => {
    const answer = await requestLine(join(directory, "none.sock"), "x", 1000);

    expect(answer.isErr() && answer.error.code).toBe("ENOENT");
  });
});
