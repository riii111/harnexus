import { describe, expect, test } from "bun:test";
import { type PassThrough, Writable } from "node:stream";
import {
  createLineInjector,
  createLineRewriter,
  createOwnResponseFilter,
} from "./inject.ts";

describe("createLineInjector", () => {
  test("writes an injected line at once on a line boundary", async () => {
    const target = sink();
    const injector = createLineInjector(target.stream);

    await write(injector.stream, "app 1\n");
    injector.inject("own\n");
    await write(injector.stream, "app 2\n");

    expect(target.text()).toBe("app 1\nown\napp 2\n");
  });

  test("holds an injected line until the app finishes its current line", async () => {
    const target = sink();
    const injector = createLineInjector(target.stream);

    await write(injector.stream, "app 1 first half");
    injector.inject("own\n");
    await write(injector.stream, " second half\napp 2 st");
    await write(injector.stream, "art\n");

    expect(target.text()).toBe(
      "app 1 first half second half\nown\napp 2 start\n",
    );
  });

  test("completes an empty write only after injected lines reach a slow target", async () => {
    const target = sink(10);
    const injector = createLineInjector(target.stream);

    injector.inject("own\n");
    await write(injector.stream, "");

    expect(target.text()).toBe("own\n");
  });

  test("ends the target when the app ends", async () => {
    const target = sink();
    const injector = createLineInjector(target.stream);

    injector.stream.end("last\n");
    await new Promise((resolve) => target.stream.once("finish", resolve));

    expect(target.text()).toBe("last\n");
  });
});

describe("createLineInjector on a broken target", () => {
  test("passes a failed write to the relay and stops injecting", async () => {
    let writes = 0;
    const target = new Writable({
      write(_chunk, _encoding, callback) {
        writes += 1;
        callback(Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
      },
    });
    const injector = createLineInjector(target);
    const failed = new Promise((resolve) =>
      injector.stream.once("close", resolve),
    );

    injector.inject("own 1\n");
    await failed;
    injector.inject("own 2\n");

    expect(injector.stream.destroyed).toBe(true);
    expect(writes).toBe(1);
  });
});

describe("createOwnResponseFilter", () => {
  test("drops own lines split across chunks and keeps every other byte", async () => {
    const own: string[] = [];
    const filter = createOwnResponseFilter(
      (line) => line.includes("OWN"),
      (line) => own.push(line.toString()),
    );
    const output = collect(filter);

    filter.write("keep 1\nO");
    filter.write("WN reply\nkeep 2\npar");
    filter.end("tial");
    const text = await output;

    expect(text).toBe("keep 1\nkeep 2\npartial");
    expect(own).toEqual(["OWN reply\n"]);
  });
});

describe("createLineRewriter", () => {
  test("replaces or drops whole lines however the chunks split them", async () => {
    const rewriter = createLineRewriter((line) => {
      const text = line.toString();
      if (text.startsWith("drop")) return null;
      return Buffer.from(text.toUpperCase());
    });
    const output = collect(rewriter);

    rewriter.write("keep\ndr");
    rewriter.write("op me\nlast");
    rewriter.end(" part");

    expect(await output).toBe("KEEP\nlast part");
  });
});

const sink = (delayMs = 0) => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const store = () => {
        chunks.push(Buffer.from(chunk));
        callback();
      };
      if (delayMs === 0) store();
      else setTimeout(store, delayMs);
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString() };
};

const write = (stream: Writable, text: string) =>
  new Promise<void>((resolve) => stream.write(text, () => resolve()));

const collect = async (stream: PassThrough | NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
};
