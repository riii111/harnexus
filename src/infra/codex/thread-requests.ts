import { Result, TaggedError } from "better-result";

import { isObject } from "../../lib/object.ts";
import type { ServerRequest, ServerRequestError } from "./server-requests.ts";

class ArchivedListUnreadable extends TaggedError("ArchivedListUnreadable")<{
  message: string;
}> {}

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
  archivedThreadIds: () => listArchivedThreadIds(request),
});

const listArchivedThreadIds = async (
  request: ServerRequest,
): Promise<
  Result<ReadonlySet<string>, ServerRequestError | ArchivedListUnreadable>
> => {
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < ARCHIVED_PAGE_LIMIT; page++) {
    const answered = await request(
      "thread/list",
      {
        archived: true,
        cursor,
        limit: ARCHIVED_PAGE_SIZE,
        sourceKinds: ARCHIVED_SOURCE_KINDS,
        useStateDbOnly: true,
      },
      { timeoutMs: 30_000 },
    );
    if (answered.isErr()) return Result.err(answered.error);
    const body = answered.value;
    if (!isObject(body) || !Array.isArray(body.data)) {
      return Result.err(
        new ArchivedListUnreadable({
          message: "thread/list did not answer with a list of threads",
        }),
      );
    }

    for (const thread of body.data as unknown[]) {
      if (isObject(thread) && typeof thread.id === "string") {
        ids.add(thread.id);
      }
    }

    if (typeof body.nextCursor !== "string") return Result.ok(ids);
    cursor = body.nextCursor;
  }

  return Result.err(
    new ArchivedListUnreadable({
      message: "thread/list did not reach the last page of archived threads",
    }),
  );
};

// Every kind the app starts a chat from, so an archived Cloud chat is listed whichever kind it was opened as.
const ARCHIVED_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"];

const ARCHIVED_PAGE_SIZE = 200;

// A server that never ends the pages is given up on rather than followed without end.
const ARCHIVED_PAGE_LIMIT = 100;
