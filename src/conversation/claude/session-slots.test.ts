import { describe, expect, test } from "bun:test";
import { createSessionSlots, type SessionSlot } from "./session-slots.ts";

describe("createSessionSlots", () => {
  test("closes a dropped session and tells onDropped once", () => {
    const { slots, closes, dropped } = fixture();
    const slot = fakeSlot("a", closes);
    slots.open("thread-1", slot);

    slots.drop("thread-1", slot);

    expect(closes).toEqual(["a"]);
    expect(dropped).toEqual(["thread-1"]);
    expect(slots.slotOf("thread-1")).toBeUndefined();
  });

  test("closes a session a newer one replaced without telling onDropped", () => {
    const { slots, closes, dropped } = fixture();
    const stale = fakeSlot("stale", closes);
    const current = fakeSlot("current", closes);
    slots.open("thread-1", stale);
    slots.open("thread-1", current);

    slots.drop("thread-1", stale);

    expect(closes).toEqual(["stale"]);
    expect(dropped).toEqual([]);
    expect(slots.slotOf("thread-1")).toBe(current);
  });

  test("closes the session of a thread asked to close", () => {
    const { slots, closes, dropped } = fixture();
    slots.open("thread-1", fakeSlot("a", closes));

    slots.close("thread-1");
    slots.close("thread-2");

    expect(closes).toEqual(["a"]);
    expect(dropped).toEqual(["thread-1"]);
  });

  test("closeAll drops every session and cancels a start with its writes stopped", () => {
    const { slots, closes, dropped } = fixture();
    slots.open("thread-1", fakeSlot("a", closes));
    slots.open("thread-2", fakeSlot("b", closes));
    const startup = slots.beginStart({ threadId: "thread-3" });
    const stopped: string[] = [];
    startup.link = {
      stopWrites: () => stopped.push("thread-3"),
    } as unknown as NonNullable<typeof startup.link>;

    slots.closeAll();

    expect(closes).toEqual(["a", "b"]);
    expect(dropped).toEqual(["thread-1", "thread-2"]);
    expect(startup.controller.signal.aborted).toBe(true);
    expect(stopped).toEqual(["thread-3"]);
    expect(slots.startingOf("thread-3")).toBeUndefined();
  });

  test("leaves a start alone that a newer start replaced when the older one is cleared", () => {
    const { slots } = fixture();
    const older = slots.beginStart({ threadId: "thread-1" });
    const newer = slots.beginStart({ threadId: "thread-1" });

    slots.clearStart("thread-1", older);
    slots.cancelStart("thread-1", older);

    expect(slots.startingOf("thread-1")).toBe(newer);
    expect(newer.controller.signal.aborted).toBe(false);
  });
});

const fixture = () => {
  const closes: string[] = [];
  const dropped: string[] = [];
  const slots = createSessionSlots<{ threadId: string }>({
    threads: { sessionIdOf: () => "se-1" },
    idleSessionMs: 60_000,
    log: () => {},
    onDropped: (threadId) => dropped.push(threadId),
  });
  return { slots, closes, dropped };
};

const fakeSlot = (name: string, closes: string[]) =>
  ({
    session: { close: () => closes.push(name) },
    model: "claude-opus-5-5",
    pendingInterrupt: null,
    link: { stopWrites: () => {} },
    attachedSkills: new Map(),
    reader: null,
    unclaimed: null,
    discarding: false,
    backgroundTasks: 0,
  }) as unknown as SessionSlot;
