import { describe, expect, test } from "bun:test";
import { createSerialQueue } from "./serial-queue.ts";

describe("createSerialQueue", () => {
  test("runs tasks with the same key one at a time in arrival order", async () => {
    const queue = createSerialQueue();
    const events: string[] = [];
    const first = deferred();

    const a = queue.run("thread-1", async () => {
      events.push("a:start");
      await first.promise;
      events.push("a:end");
    });
    const b = queue.run("thread-1", async () => {
      events.push("b:start");
    });
    await tick();
    expect(events).toEqual(["a:start"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b:start"]);
  });

  test("runs tasks with different keys concurrently", async () => {
    const queue = createSerialQueue();
    const blocker = deferred();
    const events: string[] = [];

    const a = queue.run("thread-1", async () => {
      await blocker.promise;
      events.push("a");
    });
    const b = queue.run("thread-2", async () => {
      events.push("b");
    });
    await b;
    expect(events).toEqual(["b"]);

    blocker.resolve();
    await a;
    expect(events).toEqual(["b", "a"]);
  });

  test("keeps running later tasks after a task rejects", async () => {
    const queue = createSerialQueue();

    const failed = queue.run("thread-1", () =>
      Promise.reject(new Error("boom")),
    );
    const next = queue.run("thread-1", async () => "next");

    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("next");
  });
});

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
