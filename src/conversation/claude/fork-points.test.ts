import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { createForkPoints } from "./fork-points.ts";

describe("createForkPoints", () => {
  test("points a fork at its pinned record without reading the source", async () => {
    const read: string[] = [];
    const points = forkPoints({ source: "se-1", pin: "a-1" }, read);

    await points.note("fork");

    expect(points.pointOf("fork")).toEqual({ at: "a-1" });
    expect(read).toEqual([]);
  });

  test("points a fork at the last record its source holds when nothing pins it", async () => {
    const read: string[] = [];
    const points = forkPoints({ source: "se-1", pin: null }, read);

    await points.note("fork");

    expect(points.pointOf("fork")).toEqual({ at: "a-2" });
    expect(read).toEqual(["se-1"]);
  });

  test("points a fork whose source had said nothing at no record", async () => {
    const points = forkPoints({ source: "se-1", pin: null }, [], null);

    await points.note("fork");

    expect(points.pointOf("fork")).toEqual({ at: null });
  });

  test("notes nothing for a thread that is no fork", async () => {
    const points = forkPoints({ source: null, pin: null }, []);

    await points.note("fork");

    expect(points.pointOf("fork")).toBeUndefined();
  });

  test("forgets the point of a fork handed back to Codex", async () => {
    const points = forkPoints({ source: "se-1", pin: "a-1" }, []);
    await points.note("fork");

    points.forget("fork");

    expect(points.pointOf("fork")).toBeUndefined();
  });
});

const forkPoints = (
  fork: { source: string | null; pin: string | null },
  read: string[],
  last: string | null = "a-2",
) =>
  createForkPoints({
    threads: { forkSourceOf: () => fork.source, forkPinOf: () => fork.pin },
    lastRecordOf: async (sessionId) => {
      read.push(sessionId);
      return Result.ok(last);
    },
  });
