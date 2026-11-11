import { describe, expect, test } from "bun:test";

import { Result } from "better-result";

import { createThreadRequests } from "./thread-requests.ts";

describe("createThreadRequests", () => {
  test("sends thread operations with the server protocol and propagates its result", async () => {
    const calls: unknown[][] = [];
    const answer = Result.ok({ data: [] });
    const threads = createThreadRequests(async (...args) => {
      calls.push(args);
      return answer;
    });

    expect(await threads.rename("th-1", "name")).toBe(answer);
    expect(await threads.inject("th-1", [{ type: "message" }])).toBe(answer);
    expect(
      await threads.listTurns("th-1", { limit: 5, sortDirection: "desc" }),
    ).toBe(answer);
    expect(
      await threads.subagentParent("thread/read", { threadId: "th-1" }),
    ).toBe(answer);
    expect(calls).toEqual([
      [
        "thread/name/set",
        { threadId: "th-1", name: "name" },
        { timeoutMs: 10_000 },
      ],
      [
        "thread/inject_items",
        { threadId: "th-1", items: [{ type: "message" }] },
        { timeoutMs: 30_000 },
      ],
      [
        "thread/turns/list",
        {
          threadId: "th-1",
          limit: 5,
          sortDirection: "desc",
          itemsView: "full",
        },
        { timeoutMs: 30_000 },
      ],
      ["thread/read", { threadId: "th-1" }, { timeoutMs: 10_000 }],
    ]);
  });
});

describe("createThreadRequests.archivedThreadIds", () => {
  test("collects the ids of every page of archived threads and asks for archived threads only", async () => {
    const calls: unknown[][] = [];
    const pages = [
      Result.ok({ data: [{ id: "th-1" }, { id: "th-2" }], nextCursor: "c1" }),
      Result.ok({ data: [{ id: "th-3" }], nextCursor: null }),
    ];
    const threads = createThreadRequests(async (...args) => {
      calls.push(args);
      return pages[calls.length - 1] ?? Result.ok({ data: [] });
    });

    const listed = await threads.archivedThreadIds();

    expect(listed.isOk() && [...listed.value]).toEqual([
      "th-1",
      "th-2",
      "th-3",
    ]);
    expect(calls.map(([method, params]) => [method, params])).toEqual([
      [
        "thread/list",
        expect.objectContaining({ archived: true, cursor: null }),
      ],
      [
        "thread/list",
        expect.objectContaining({ archived: true, cursor: "c1" }),
      ],
    ]);
  });

  test("returns the server's failure when a page cannot be read", async () => {
    const failure = Result.err({ _tag: "ServerRequestUnanswered" });
    const threads = createThreadRequests(async () => failure as never);

    const listed = await threads.archivedThreadIds();

    expect(listed.isErr() && listed.error._tag).toBe("ServerRequestUnanswered");
  });

  test("fails on an answer that holds no list of threads", async () => {
    const threads = createThreadRequests(async () => Result.ok({ oops: 1 }));

    const listed = await threads.archivedThreadIds();

    expect(listed.isErr() && listed.error._tag).toBe("ArchivedListUnreadable");
  });

  test("gives up on pages that never end", async () => {
    const threads = createThreadRequests(async () =>
      Result.ok({ data: [], nextCursor: "again" }),
    );

    const listed = await threads.archivedThreadIds();

    expect(listed.isErr() && listed.error._tag).toBe("ArchivedListUnreadable");
  });
});
