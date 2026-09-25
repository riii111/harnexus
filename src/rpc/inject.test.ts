import { describe, expect, test } from "bun:test";
import { type PassThrough, Writable } from "node:stream";
import { createLineInjector, createOwnResponseFilter } from "./inject.ts";

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

  test("ends the target when the app ends", async () => {
    const target = sink();
    const injector = createLineInjector(target.stream);

    injector.stream.end("last\n");
    await new Promise((resolve) => target.stream.once("finish", resolve));

    expect(target.text()).toBe("last\n");
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

const sink = () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
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
