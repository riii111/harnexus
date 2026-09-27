import { describe, expect, test } from "bun:test";
import { buildHistory } from "./history.ts";
import {
  pageItems,
  pageTimeline,
  pageTurns,
  resumeCursors,
  type TurnsView,
} from "./history-page.ts";
import { prompt, reply, text } from "./testing/session-record.ts";

describe("pageTurns", () => {
  test("pages back from the resume cursor through every turn with the next cursors", () => {
    const history = threeTurns();
    const next = (cursor: string | null | undefined) =>
      pageTurns(history, turnsRequest({ limit: 1, cursor: cursor ?? null }));

    const first = next(resumeCursors(history).turnsBackwardsCursor);
    const second = next(first?.nextCursor);
    const third = next(second?.nextCursor);

    expect(
      [first, second, third].map((page) => page?.data.map((turn) => turn.id)),
    ).toEqual([[T3], [T2], [T1]]);
    expect(third?.nextCursor).toBeNull();
  });

  test("includes the anchor turn again when the backwards cursor reverses the direction", () => {
    const history = threeTurns();
    const older = pageTurns(
      history,
      turnsRequest({ limit: 1, cursor: `at:${T2}` }),
    );

    const newer = pageTurns(
      history,
      turnsRequest({
        cursor: older?.backwardsCursor ?? null,
        sortDirection: "asc",
      }),
    );

    expect(older?.data.map((turn) => turn.id)).toEqual([T2]);
    expect(newer?.data.map((turn) => turn.id)).toEqual([T2, T3]);
  });

  test.each<{ name: string; itemsView: TurnsView; expected: string[] }>([
    { name: "notLoaded", itemsView: "notLoaded", expected: [] },
    { name: "summary", itemsView: "summary", expected: ["agentMessage"] },
    {
      name: "full",
      itemsView: "full",
      expected: ["userMessage", "agentMessage"],
    },
  ])("returns the items the $name view asks for", ({ itemsView, expected }) => {
    const page = pageTurns(threeTurns(), turnsRequest({ limit: 1, itemsView }));

    expect(page?.data[0]?.itemsView).toBe(itemsView);
    expect(page?.data[0]?.items.map((item): string => item.type)).toEqual(
      expected,
    );
  });

  test.each([
    { name: "an unknown turn", cursor: "at:harnexus-history-gone" },
    { name: "a malformed cursor", cursor: "server-cursor" },
  ])("refuses a cursor naming $name", ({ cursor }) => {
    expect(pageTurns(threeTurns(), turnsRequest({ cursor }))).toBeNull();
  });
});

describe("pageItems", () => {
  test("starts a turn's pages from the thread's newest item, as the app does for every turn", () => {
    const history = threeTurns();
    const { itemsBackwardsCursor } = resumeCursors(history);

    const page = pageItems(history, {
      turnId: T2,
      cursor: itemsBackwardsCursor,
      limit: 100,
      sortDirection: "desc",
    });

    expect(page?.data.map((entry) => [entry.turnId, entry.item.type])).toEqual([
      [T2, "agentMessage"],
      [T2, "userMessage"],
    ]);
    expect(page?.nextCursor).toBeNull();
  });

  test("continues a turn's items after the next cursor", () => {
    const history = threeTurns();
    const first = pageItems(history, {
      turnId: T1,
      cursor: null,
      limit: 1,
      sortDirection: "asc",
    });

    const rest = pageItems(history, {
      turnId: T1,
      cursor: first?.nextCursor ?? null,
      limit: 1,
      sortDirection: "asc",
    });

    expect(first?.data.map((entry) => entry.item.type)).toEqual([
      "userMessage",
    ]);
    expect(rest?.data.map((entry) => entry.item.type)).toEqual([
      "agentMessage",
    ]);
    expect(rest?.nextCursor).toBeNull();
  });

  test("returns every item of the thread from the resume cursor without a turn", () => {
    const history = threeTurns();

    const page = pageItems(history, {
      turnId: null,
      cursor: resumeCursors(history).itemsBackwardsCursor,
      limit: null,
      sortDirection: "desc",
    });

    expect(page?.data.map((entry) => entry.turnId)).toEqual([
      T3,
      T3,
      T2,
      T2,
      T1,
      T1,
    ]);
  });
});

describe("pageTimeline", () => {
  test("returns the newest entries first and pages back to the start with the next cursor", () => {
    const history = threeTurns();

    const newest = pageTimeline(history, { cursor: null, limit: 8 });
    const oldest = pageTimeline(history, {
      cursor: newest?.nextCursor ?? null,
      limit: 8,
    });

    expect(newest?.data.map((entry) => entry.position)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(oldest?.data.map((entry) => entry.type)).toEqual([
      "turnStarted",
      "item",
      "item",
      "turnCompleted",
    ]);
    expect(oldest?.nextCursor).toBeNull();
  });

  test("refuses a cursor past the end of the timeline", () => {
    expect(
      pageTimeline(threeTurns(), { cursor: "before:99", limit: null }),
    ).toBeNull();
  });
});

describe("resumeCursors", () => {
  test("leaves both cursors null for a thread without history", () => {
    expect(resumeCursors([])).toEqual({
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    });
  });
});

const T1 = "harnexus-history-u1";
const T2 = "harnexus-history-u2";
const T3 = "harnexus-history-u3";

const threeTurns = () =>
  buildHistory(
    [
      prompt("u1", "one"),
      reply("a1", "m1", text("first"), "end_turn"),
      prompt("u2", "two"),
      reply("a2", "m2", text("second"), "end_turn"),
      prompt("u3", "three"),
      reply("a3", "m3", text("third"), "end_turn"),
    ],
    { threadId: "th-claude", cwd: "/fixture/work" },
  );

const turnsRequest = (
  change: Partial<Parameters<typeof pageTurns>[1]>,
): Parameters<typeof pageTurns>[1] => ({
  cursor: null,
  limit: null,
  sortDirection: "desc",
  itemsView: "notLoaded",
  ...change,
});
