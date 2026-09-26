import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createLineInjector } from "./inject.ts";

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

  test("passes a failed write to the relay and stops injecting", async () => {
    const target = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
      },
    });
    const injector = createLineInjector(target);
    const failed = new Promise((resolve) =>
      injector.stream.once("close", resolve),
    );

    injector.inject("own 1\n");
    await failed;

    expect(injector.stream.destroyed).toBe(true);
    expect(injector.inject("own 2\n")).toBe(false);
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
