import { type InferErr, Result } from "better-result";
import type { readClaudeSession } from "../infra/claude/session.ts";
import { buildHistory, type HistoryTurn } from "../presentation/history.ts";
import {
  pageItems,
  pageTimeline,
  pageTurns,
  resumeCursors,
  type SortDirection,
  type TurnsView,
  viewTurn,
} from "../presentation/history-page.ts";
import { isObject } from "../runtime/object.ts";
import type { AppRequest, Thread } from "./thread-request.ts";

export type HistoryEvent = {
  event: "claude_history_unreadable";
  error: InferErr<Awaited<ReturnType<ReadSession>>>["_tag"];
};

export type HistoryMethod = (typeof HISTORY_METHODS)[number];

type Threads = {
  threadOf: (threadId: string) => Thread | undefined;
  sessionIdOf: (threadId: string) => string | null;
};

type ReadSession = (sessionId: string) => ReturnType<typeof readClaudeSession>;

type Loaded = Result<HistoryTurn[], InferErr<Awaited<ReturnType<ReadSession>>>>;

// The server never sees a Claude turn, so a Claude thread's history comes from Claude's own record and is rebuilt on each request rather than stored by the bridge.
export const createHistoryRequests = ({
  threads,
  readSession,
  send,
  log,
}: {
  threads: Threads;
  readSession: ReadSession;
  send: (message: object) => void;
  log: (event: HistoryEvent) => void;
}) => {
  // The app asks for a turn page and then each turn's items at once, so requests arriving while a read runs share it.
  const reading = new Map<string, Promise<Loaded>>();

  // A thread with no session yet has an empty history.
  const load = (threadId: string): Promise<Loaded> => {
    const running = reading.get(threadId);
    if (running !== undefined) return running;
    const thread = threads.threadOf(threadId);
    const sessionId = threads.sessionIdOf(threadId);
    if (thread === undefined || sessionId === null) {
      return Promise.resolve(Result.ok([]));
    }
    const loaded = readSession(sessionId).then((read) => {
      reading.delete(threadId);
      return read
        .tapError((error) =>
          log({ event: "claude_history_unreadable", error: error._tag }),
        )
        .map((messages) =>
          buildHistory(messages, { threadId, cwd: thread.cwd }),
        );
    });
    reading.set(threadId, loaded);
    return loaded;
  };

  const answer = async (method: HistoryMethod, request: AppRequest) => {
    const threadId = String(request.params.threadId);
    const history = await load(threadId);
    if (history.isErr()) {
      send({
        id: request.id,
        error: { code: INTERNAL_ERROR, message: RECORD_UNREADABLE },
      });
      return;
    }
    const result = pageFor(method, history.value, request.params);
    send(
      result === null
        ? {
            id: request.id,
            error: { code: INVALID_PARAMS, message: UNKNOWN_CURSOR },
          }
        : { id: request.id, result },
    );
  };

  return { load, answer };
};

export const isHistoryMethod = (method: string): method is HistoryMethod =>
  (HISTORY_METHODS as readonly string[]).includes(method);

// The app pages back from the cursors whenever the thread's history is paginated and shows nothing when they are null, and asks for the initial page or the full turns otherwise.
export const withResumeHistory = (
  result: Record<string, unknown>,
  history: readonly HistoryTurn[],
  params: Record<string, unknown>,
) => {
  const initial = isObject(params.initialTurnsPage)
    ? params.initialTurnsPage
    : null;
  return {
    ...(params.excludeTurns === true ? result : withTurns(result, history)),
    ...resumeCursors(history),
    ...(initial !== null && {
      initialTurnsPage: pageTurns(history, {
        cursor: null,
        limit: limitOf(initial.limit),
        sortDirection: directionOf(initial.sortDirection, "desc"),
        itemsView: viewOf(initial.itemsView),
      }),
    }),
  };
};

export const withTurns = (
  result: Record<string, unknown>,
  history: readonly HistoryTurn[],
) =>
  isObject(result.thread)
    ? {
        ...result,
        thread: {
          ...result.thread,
          turns: history.map((entry) => viewTurn(entry, "full")),
        },
      }
    : result;

const pageFor = (
  method: HistoryMethod,
  history: readonly HistoryTurn[],
  params: Record<string, unknown>,
) => {
  const cursor = typeof params.cursor === "string" ? params.cursor : null;
  const limit = limitOf(params.limit);
  switch (method) {
    case "thread/turns/list":
      return pageTurns(history, {
        cursor,
        limit,
        sortDirection: directionOf(params.sortDirection, "desc"),
        itemsView: viewOf(params.itemsView),
      });
    case "thread/items/list":
      return pageItems(history, {
        turnId: typeof params.turnId === "string" ? params.turnId : null,
        cursor,
        limit,
        sortDirection: directionOf(params.sortDirection, "asc"),
      });
    case "thread/timeline/list": {
      const page = pageTimeline(history, { cursor, limit });
      return page === null
        ? null
        : { ...page, activeRealtimeSessionAtPageStart: null };
    }
  }
};

const limitOf = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const directionOf = (value: unknown, fallback: SortDirection): SortDirection =>
  value === "asc" || value === "desc" ? value : fallback;

const viewOf = (value: unknown): TurnsView =>
  value === "notLoaded" || value === "full" ? value : "summary";

const HISTORY_METHODS = [
  "thread/turns/list",
  "thread/items/list",
  "thread/timeline/list",
] as const;

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const RECORD_UNREADABLE =
  "Harnexus cannot read this thread's Claude conversation record.";
const UNKNOWN_CURSOR = "The cursor does not name a page of this Claude thread.";
