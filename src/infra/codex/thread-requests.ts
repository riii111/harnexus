import type { ServerRequest } from "./server-requests.ts";

export const createThreadRequests = (request: ServerRequest) => ({
  rename: (threadId: string, name: string) =>
    request("thread/name/set", { threadId, name }, { timeoutMs: 10_000 }),
  inject: (threadId: string, items: object[]) =>
    request("thread/inject_items", { threadId, items }, { timeoutMs: 30_000 }),
  listTurns: (
    threadId: string,
    page: { limit: number; sortDirection: "asc" | "desc" },
  ) =>
    request(
      "thread/turns/list",
      { threadId, ...page, itemsView: "full" },
      { timeoutMs: 30_000 },
    ),
  subagentParent: (method: string, params: unknown) =>
    request(method, params, { timeoutMs: 10_000 }),
});
