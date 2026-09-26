import { describe, expect, test } from "bun:test";
import { createSerialQueue } from "./serial-queue.ts";

describe("createSerialQueue", () => {
  test("runs tasks with the same key one at a time in arrival order", async () => {
    const queue = createSerialQueue();
    const events: string[] = [];
    const first = deferred();
    const second = deferred();

    const a = queue.run("thread-1", async () => {
      events.push("a:start");
      await first.promise;
      events.push("a:end");
    });
    const b = queue.run("thread-1", async () => {
      events.push("b:start");
      await second.promise;
      events.push("b:end");
    });
    await tick();
    expect(events).toEqual(["a:start"]);

    first.resolve();
    await a;
    await tick();
    const c = queue.run("thread-1", async () => {
      events.push("c:start");
    });
    await tick();
    expect(events).toEqual(["a:start", "a:end", "b:start"]);

    second.resolve();
    await Promise.all([b, c]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start"]);
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
