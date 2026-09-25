import { describe, expect, test } from "bun:test";
import { PassThrough, type Readable, Writable } from "node:stream";
import { attachServerRequests } from "./server-requests.ts";

describe("attachServerRequests", () => {
  test("sends a prefixed request and takes its response out of the app output", async () => {
    const server = fakeServer();
    const requests = attachServerRequests(server);
    const appOutput = collect(requests.serverOutput);

    const answer = requests.request("mcpServer/tool/call", { a: 1 }, TIMEOUT);
    expect(server.sent()).toEqual([
      { id: "harnexus-1", method: "mcpServer/tool/call", params: { a: 1 } },
    ]);
    server.output.write('{"id":7,"result":{"text":"\\"harnexus-1"}}\n');
    server.output.write('{"id":"harnexus-1","result":{"ok":true}}\n');
    server.output.end('{"method":"turn/started"}\n');

    const result = await answer;
    expect(result.isOk() && result.value).toEqual({ ok: true });
    expect(await appOutput).toBe(
      '{"id":7,"result":{"text":"\\"harnexus-1"}}\n{"method":"turn/started"}\n',
    );
  });

  test("passes the app a response to an id this bridge never issued", async () => {
    const server = fakeServer();
    const requests = attachServerRequests(server);
    const appOutput = collect(requests.serverOutput);

    const answer = requests.request("list", {}, TIMEOUT);
    server.output.write('{"id":"harnexus-9","result":{}}\n');
    server.output.write('{"id":"harnexus-1","method":"x","result":{}}\n');
    server.output.write('{"id":"harnexus-1","result":{}}\n');
    server.output.end();

    expect((await answer).isOk()).toBe(true);
    expect(await appOutput).toBe(
      '{"id":"harnexus-9","result":{}}\n{"id":"harnexus-1","method":"x","result":{}}\n',
    );
  });

  test("keeps a late answer to a timed-out request away from the app", async () => {
    const server = fakeServer();
    const requests = attachServerRequests(server);
    const appOutput = collect(requests.serverOutput);

    const result = await requests.request("list", {}, { timeoutMs: 10 });
    server.output.write('{"id":"harnexus-1","result":{"late":true}}\n');
    server.output.end('{"method":"turn/started"}\n');

    expect(result.isErr() && result.error._tag).toBe("ServerRequestUnanswered");
    expect(await appOutput).toBe('{"method":"turn/started"}\n');
  });

  test("returns an error response as a rejection with its code", async () => {
    const server = fakeServer();
    const requests = attachServerRequests(server);
    void collect(requests.serverOutput);

    const answer = requests.request("list", {}, TIMEOUT);
    server.output.write(
      '{"id":"harnexus-1","error":{"code":-32600,"message":"bad"}}\n',
    );

    const result = await answer;
    expect(result.isErr() && result.error).toMatchObject({
      _tag: "ServerRequestRejected",
      code: -32600,
      message: "bad",
    });
  });

  test("reports a request without an answer in time as unanswered", async () => {
    const server = fakeServer();
    const requests = attachServerRequests(server);
    void collect(requests.serverOutput);

    const result = await requests.request("list", {}, { timeoutMs: 10 });

    expect(result.isErr() && result.error._tag).toBe("ServerRequestUnanswered");
  });

  test("reports pending requests as unanswered when the server output ends, and sends nothing after", async () => {
    const server = fakeServer();
    const requests = attachServerRequests(server);
    const appOutput = collect(requests.serverOutput);

    const answer = requests.request("list", {}, TIMEOUT);
    server.output.end();
    await appOutput;
    const later = await requests.request("list", {}, TIMEOUT);

    const result = await answer;
    expect(result.isErr() && result.error._tag).toBe("ServerRequestUnanswered");
    expect(later.isErr() && later.error._tag).toBe("ServerRequestNotSent");
    expect(server.sent()).toHaveLength(1);
  });

  test("reports a request as not sent when the server input is broken", async () => {
    const output = new PassThrough();
    const input = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
      },
    });
    const requests = attachServerRequests({
      serverInput: input,
      serverOutput: output,
    });
    requests.serverInput.on("error", () => {});
    void collect(requests.serverOutput);

    void requests.request("first", {}, { timeoutMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await requests.request("second", {}, TIMEOUT);

    expect(result.isErr() && result.error._tag).toBe("ServerRequestNotSent");
  });
});

const fakeServer = () => {
  const lines: string[] = [];
  const input = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(...Buffer.from(chunk).toString().split("\n").filter(Boolean));
      callback();
    },
  });
  const output = new PassThrough();
  return {
    serverInput: input,
    serverOutput: output as Readable,
    output,
    sent: () => lines.map((line) => JSON.parse(line)),
  };
};

const collect = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
};

const TIMEOUT = { timeoutMs: 5_000 };
