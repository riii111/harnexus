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
