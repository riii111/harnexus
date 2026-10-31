import { describe, expect, test } from "bun:test";
import { createTurnRecords } from "./turn-records.ts";

describe("createTurnRecords", () => {
  test("answers the record a turn was noted with", () => {
    const records = createTurnRecords();

    records.note("thread-1", "turn-1", "uuid-1");
    records.note("thread-1", "turn-2", "uuid-2");

    expect(records.recordOf("thread-1", "turn-1")).toBe("uuid-1");
    expect(records.recordOf("thread-1", "turn-2")).toBe("uuid-2");
  });

  test("answers null for a turn it was not told of, on a known thread and an unknown one", () => {
    const records = createTurnRecords();
    records.note("thread-1", "turn-1", "uuid-1");

    expect(records.recordOf("thread-1", "turn-9")).toBeNull();
    expect(records.recordOf("thread-2", "turn-1")).toBeNull();
  });

  test("keeps the turns of two threads apart", () => {
    const records = createTurnRecords();

    records.note("thread-1", "turn-1", "uuid-1");
    records.note("thread-2", "turn-1", "uuid-2");

    expect(records.recordOf("thread-1", "turn-1")).toBe("uuid-1");
    expect(records.recordOf("thread-2", "turn-1")).toBe("uuid-2");
  });
});
