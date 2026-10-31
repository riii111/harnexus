import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { type InferErr, Result } from "better-result";
import { ClaudeRecordUnreadable } from "../infra/claude/sdk.boundary.ts";
import type { readClaudeSession } from "../infra/claude/session.ts";
import {
  type AgentRef,
  buildHistory,
  type HistoryTurn,
  historyTurnId,
  type LiveTurn,
  withLiveTurn,
} from "../presentation/history.ts";
import {
  itemAnchorCursor,
  pageItems,
  pageTimeline,
  pageTurns,
  resumeCursors,
  type SortDirection,
  type TurnsView,
  viewTurn,
} from "../presentation/history-page.ts";
import { isObject } from "../runtime/object.ts";
import type { AppRequest } from "./thread-request.ts";
import type { ThreadValues } from "./thread-values.ts";

export type HistoryEvent =
  | {
      event: "claude_history_unreadable";
      error: InferErr<Awaited<ReturnType<ReadSession>>>["_tag"];
    }
  | {
      event: "claude_history_answered";
      method: HistoryMethod;
      thread: string;
      live: string | null;
      turn: string | null;
      cursor: string | null;
      returned: string[] | null;
    };

type HistoryMethod = (typeof HISTORY_METHODS)[number];

type ReadSession = (sessionId: string) => ReturnType<typeof readClaudeSession>;

type Loaded = Result<HistoryTurn[], InferErr<Awaited<ReturnType<ReadSession>>>>;

// Answers the app's history requests for Claude threads and their subagents, which the server never sees.
export const createHistoryRequests = ({
  threads,
  liveTurnOf,
  recordOf,
  readSession,
  send,
  log,
  subagentHistory,
  subagents,
}: {
  threads: Pick<ThreadValues, "threadOf" | "sessionIdOf" | "rewindOf">;
  liveTurnOf: (threadId: string) => LiveTurn | null;
  recordOf: (threadId: string, turnId: string) => string | null;
  readSession: ReadSession;
  send: (message: object) => void;
  log: (event: HistoryEvent) => void;
  subagentHistory: (threadId: string) => HistoryTurn[] | undefined;
  subagents: SubagentsOfThread;
}) => {
  // The app asks for a turn page and then each turn's items at once, so requests arriving while a read runs share it.
  const reading = new Map<string, { key: string; loaded: Promise<Loaded> }>();
  const keyOf = (threadId: string) =>
    JSON.stringify([
      threads.sessionIdOf(threadId),
      threads.rewindOf(threadId) ?? null,
    ]);

  const load = (threadId: string): Promise<Loaded> => {
    // A subagent's thread has no record the app can name, so its history comes from what the bridge kept of it.
    const kept = subagentHistory(threadId);
    if (kept !== undefined) return Promise.resolve(Result.ok(kept));
    const key = keyOf(threadId);
    const running = reading.get(threadId);
    if (running?.key === key) return running.loaded;
    const thread = threads.threadOf(threadId);
    const sessionId = threads.sessionIdOf(threadId);
    if (thread === undefined || sessionId === null) {
      return Promise.resolve(Result.ok([]));
    }
    const rewind = threads.rewindOf(threadId);
    // Rebuilt from Claude's own record on each request rather than stored by the bridge.
    const loaded: Promise<Loaded> = readSession(sessionId)
      .then(async (original) => {
        if (keyOf(threadId) !== key) return load(threadId);
        const read = original.andThen((messages) => {
          if (rewind === undefined) return Result.ok(messages);
          if (rewind.at === null) return Result.ok([]);
          return recordUntil(messages, rewind.at);
        });
        // The agents are read back first, so the history shows where each started.
        if (read.isOk()) {
          await subagents.restore(threadId, sessionId, thread.cwd, read.value);
        }
        if (keyOf(threadId) !== key) return load(threadId);
        return read
          .tapError((error) =>
            log({ event: "claude_history_unreadable", error: error._tag }),
          )
          .map((messages) =>
            buildHistory(
              messages,
              { threadId, cwd: thread.cwd },
              subagents.agentRefOf(threadId),
            ),
          );
      })
      .finally(() => {
        if (reading.get(threadId)?.loaded === loaded) reading.delete(threadId);
      });
    reading.set(threadId, { key, loaded });
    return loaded;
  };

  const answer = async (method: HistoryMethod, request: AppRequest) => {
    const threadId = String(request.params.threadId);
    const loaded = await load(threadId);
    // Asked once the record is read, so a turn that ended meanwhile is not shown running.
    const live = liveTurnOf(threadId);
    const history = loaded.map((turns) => withLiveTurn(turns, live));
    if (history.isErr()) {
      send({
        id: request.id,
        error: { code: INTERNAL_ERROR, message: RECORD_UNREADABLE },
      });
      return;
    }
    // A live turn's id leaves the history once the turn ends, so a cursor or turn naming it then names the recorded turn its prompt opened.
    const known = new Set(history.value.map((entry) => entry.turn.id));
    const resolve = (turnId: string) => {
      const record = known.has(turnId) ? null : recordOf(threadId, turnId);
      return record === null ? turnId : historyTurnId(record);
    };
    const { cursor, turnId } = request.params;
    const result = pageFor(method, history.value, {
      ...request.params,
      ...(method === "thread/turns/list" &&
        typeof cursor === "string" && {
          cursor: cursor.replace(
            TURN_CURSOR,
            (_, at: string, id: string) => at + resolve(id),
          ),
        }),
      ...(typeof turnId === "string" && { turnId: resolve(turnId) }),
    });
    log({
      event: "claude_history_answered",
      method,
      thread: threadId.slice(0, 8),
      live: live === null ? null : shortId(live.turnId),
      turn: typeof turnId === "string" ? shortId(turnId) : null,
      cursor: cursorShape(cursor),
      returned:
        result === null
          ? null
          : (result.data as readonly object[]).map(returnedId),
    });
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

type SubagentsOfThread = {
  restore: (
    threadId: string,
    sessionId: string,
    cwd: string,
    messages: readonly SessionMessage[],
  ) => Promise<void>;
  agentRefOf: (threadId: string) => (toolUseId: string) => AgentRef | undefined;
};

export const recordUntil = (
  messages: readonly SessionMessage[],
  uuid: string,
): Result<SessionMessage[], ClaudeRecordUnreadable> => {
  const index = messages.findIndex((message) => message.uuid === uuid);
  // A record missing the message it was cut at is no longer the conversation that was kept.
  return index < 0
    ? Result.err(
        new ClaudeRecordUnreadable({
          cause: null,
          message: "the retained Claude record is missing",
        }),
      )
    : Result.ok(messages.slice(0, index + 1));
};

export const isHistoryMethod = (method: string): method is HistoryMethod =>
  (HISTORY_METHODS as readonly string[]).includes(method);

// A thread/resume answer with the history in the form the app asked for: the full turns, the initial page, and the cursors it pages back from.
export const withResumeHistory = (
  result: Record<string, unknown>,
  history: readonly HistoryTurn[],
  params: Record<string, unknown>,
  picked = false,
) => {
  const initial = isObject(params.initialTurnsPage)
    ? params.initialTurnsPage
    : null;
  return {
    // A thread reopened after a conversation was picked in it holds none of that conversation, so it gets the full turns even when the app excludes them.
    ...(params.excludeTurns === true && !picked
      ? result
      : withTurns(result, history)),
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

export const withLiveStatus = (
  result: Record<string, unknown>,
  live: boolean,
) =>
  // The server never runs a Claude turn, so it reports a Claude thread idle even while the bridge runs one.
  live && isObject(result.thread)
    ? { ...result, thread: { ...result.thread, status: ACTIVE } }
    : result;

export const endsLive = (history: readonly HistoryTurn[]) =>
  history.at(-1)?.turn.status === "inProgress";

const ACTIVE = { type: "active", activeFlags: [] };

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
    case "thread/items/list": {
      const request = {
        turnId: typeof params.turnId === "string" ? params.turnId : null,
        limit,
        sortDirection: directionOf(params.sortDirection, "asc"),
      };
      // The app can anchor on an item it streamed under the live turn's ids or one a rewind cut, which the record does not hold, so such an anchor reads from the start as before anchors existed.
      return isItemAnchor(params.cursor)
        ? (pageItems(history, {
            ...request,
            cursor: itemAnchorCursor(params.cursor.itemId),
          }) ?? pageItems(history, { ...request, cursor: null }))
        : pageItems(history, { ...request, cursor });
    }
    case "thread/timeline/list": {
      const page = pageTimeline(history, { cursor, limit });
      return page === null
        ? null
        : { ...page, activeRealtimeSessionAtPageStart: null };
    }
  }
};

const isItemAnchor = (value: unknown): value is { itemId: string } =>
  isObject(value) && value.type === "item" && typeof value.itemId === "string";

const limitOf = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const directionOf = (value: unknown, fallback: SortDirection): SortDirection =>
  value === "asc" || value === "desc" ? value : fallback;

const viewOf = (value: unknown): TurnsView =>
  value === "notLoaded" || value === "full" ? value : "summary";

const TURN_CURSOR = /^(at:|after:)(.+)$/s;

export const HISTORY_METHODS = [
  "thread/turns/list",
  "thread/items/list",
  "thread/timeline/list",
] as const;

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const RECORD_UNREADABLE =
  "Harnexus cannot read this thread's Claude conversation record.";
const UNKNOWN_CURSOR = "The cursor does not name a page of this Claude thread.";

export const shortId = (id: string) =>
  // Only the ids' kind and first characters are logged, enough to tell a live turn from a recorded one and match them up.
  id.replace(
    /harnexus-(history|turn)-([0-9a-f]{8})(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g,
    (_, kind: string, head: string) =>
      `${kind === "history" ? "h" : "l"}:${head}`,
  );

const cursorShape = (cursor: unknown) => {
  if (typeof cursor === "string") return shortId(cursor);
  if (isItemAnchor(cursor)) return `anchor ${shortId(cursor.itemId)}`;
  return null;
};

const returnedId = (entry: object) => {
  if (
    "item" in entry &&
    isObject(entry.item) &&
    typeof entry.item.id === "string"
  ) {
    return shortId(entry.item.id);
  }
  if ("turnId" in entry && typeof entry.turnId === "string") {
    return shortId(entry.turnId);
  }
  return "id" in entry && typeof entry.id === "string"
    ? shortId(entry.id)
    : "?";
};
