import { describe, expect, test } from "bun:test";
import { createInbox } from "./inbox.ts";

describe("inbox", () => {
  test("hands items to a waiting reader in the order they came", async () => {
    const inbox = createInbox<number>();

    const first = inbox.take();
    inbox.push(1);
    inbox.push(2);

    expect(await first).toBe(1);
    expect(await inbox.take()).toBe(2);
  });

  test("settles once the reader comes back for more", async () => {
    const inbox = createInbox<number>();
    let settled = false;

    inbox.push(1);
    const settling = inbox.settled().then(() => {
      settled = true;
    });
    await inbox.take();
    await Bun.sleep(0);
    expect(settled).toBe(false);
    void inbox.take();
    await settling;

    expect(settled).toBe(true);
  });

  test("settles when the reader gives back what it never read", async () => {
    const inbox = createInbox<number>();

    inbox.push(1);
    const settling = inbox.settled();
    inbox.drain();

    expect(await settling).toBeUndefined();
  });

  test("gives back what no reader took", async () => {
    const inbox = createInbox<number>();

    inbox.push(1);
    inbox.push(2);
    inbox.push(3);
    await inbox.take();

    expect(inbox.drain()).toEqual([2, 3]);
    expect(inbox.drain()).toEqual([]);
  });
});
