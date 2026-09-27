import type { HistoryItem, HistoryTurn } from "./history.ts";
import type { ThreadItem, Turn, TurnError } from "./protocol.ts";

export type TurnsView = "notLoaded" | "summary" | "full";

export type SortDirection = "asc" | "desc";

type Page<T> = {
  data: T[];
  nextCursor: string | null;
  backwardsCursor: string | null;
};

type TimelineEntry =
  | {
      type: "turnStarted";
      position: number;
      turnId: string;
      startedAt: number | null;
    }
  | { type: "item"; position: number; turnId: string; item: ThreadItem }
  | {
      type: "turnCompleted";
      position: number;
      turnId: string;
      status: Turn["status"];
      error: TurnError | null;
      startedAt: number | null;
      completedAt: number | null;
      durationMs: number | null;
    };

// Cursors name a turn or item id, which stays put as the conversation grows, rather than a position; a null page means the cursor names nothing in this history.
export const pageTurns = (
  history: readonly HistoryTurn[],
  request: {
    cursor: string | null;
    limit: number | null;
    sortDirection: SortDirection;
    itemsView: TurnsView;
  },
): Page<Turn> | null => {
  const paged = page(
    ordered(history, request.sortDirection),
    (entry) => entry.turn.id,
    () => true,
    request,
  );
  return paged === null
    ? null
    : {
        ...paged,
        data: paged.data.map((entry) => viewTurn(entry, request.itemsView)),
      };
};

// The app starts every turn's item pages from the thread's newest item, so a cursor may name an item of another turn and the turn filter applies after it.
export const pageItems = (
  history: readonly HistoryTurn[],
  request: {
    turnId: string | null;
    cursor: string | null;
    limit: number | null;
    sortDirection: SortDirection;
  },
): Page<HistoryItem> | null =>
  page(
    ordered(
      history.flatMap((entry) => entry.items),
      request.sortDirection,
    ),
    (entry) => entry.item.id,
    (entry) => request.turnId === null || entry.turnId === request.turnId,
    request,
  );

// The app reads the timeline from its newest page back, so a page holds the entries just before its cursor in record order.
export const pageTimeline = (
  history: readonly HistoryTurn[],
  request: { cursor: string | null; limit: number | null },
): Omit<Page<TimelineEntry>, "backwardsCursor"> | null => {
  const entries = timeline(history);
  const end =
    request.cursor === null ? entries.length : timelineEnd(request.cursor);
  if (end === null || end > entries.length) return null;
  const start = Math.max(0, end - pageSize(request.limit, end));
  return {
    data: entries.slice(start, end),
    nextCursor: start > 0 ? `${BEFORE}${start}` : null,
  };
};

// These let the app page back from the newest turn and item; the app shows no history when the turn cursor is null.
export const resumeCursors = (history: readonly HistoryTurn[]) => {
  const newestTurn = history.at(-1);
  const newestItem = history.flatMap((entry) => entry.items).at(-1);
  return {
    turnsBackwardsCursor:
      newestTurn === undefined ? null : `${AT}${newestTurn.turn.id}`,
    itemsBackwardsCursor:
      newestItem === undefined ? null : `${AT}${newestItem.item.id}`,
  };
};

export const viewTurn = (entry: HistoryTurn, view: TurnsView): Turn => {
  switch (view) {
    case "notLoaded":
      return { ...entry.turn, items: [], itemsView: "notLoaded" };
    case "summary":
      return entry.turn;
    case "full":
      return {
        ...entry.turn,
        items: entry.items.map(({ item }) => item),
        itemsView: "full",
      };
  }
};

const timeline = (history: readonly HistoryTurn[]): TimelineEntry[] => {
  const entries: TimelineEntry[] = [];
  for (const { turn, items } of history) {
    entries.push({
      type: "turnStarted",
      position: entries.length,
      turnId: turn.id,
      startedAt: turn.startedAt,
    });
    for (const { item } of items) {
      entries.push({
        type: "item",
        position: entries.length,
        turnId: turn.id,
        item,
      });
    }
    entries.push({
      type: "turnCompleted",
      position: entries.length,
      turnId: turn.id,
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    });
  }
  return entries;
};

const timelineEnd = (cursor: string) => {
  if (!cursor.startsWith(BEFORE)) return null;
  const end = Number(cursor.slice(BEFORE.length));
  return Number.isInteger(end) && end > 0 ? end : null;
};

// A next cursor resumes after the page's last entry, and a backwards cursor reverses from its first entry, which it includes again.
const page = <T>(
  entries: readonly T[],
  idOf: (entry: T) => string,
  keep: (entry: T) => boolean,
  request: { cursor: string | null; limit: number | null },
): Page<T> | null => {
  const from =
    request.cursor === null ? 0 : startOf(entries, idOf, request.cursor);
  if (from === null) return null;
  const candidates = entries.slice(from).filter(keep);
  const data = candidates.slice(0, pageSize(request.limit, candidates.length));
  const first = data[0];
  const last = data.at(-1);
  return {
    data,
    nextCursor:
      last !== undefined && candidates.length > data.length
        ? `${AFTER}${idOf(last)}`
        : null,
    backwardsCursor: first === undefined ? null : `${AT}${idOf(first)}`,
  };
};

const startOf = <T>(
  entries: readonly T[],
  idOf: (entry: T) => string,
  cursor: string,
) => {
  const inclusive = cursor.startsWith(AT);
  if (!inclusive && !cursor.startsWith(AFTER)) return null;
  const id = cursor.slice(inclusive ? AT.length : AFTER.length);
  const index = entries.findIndex((entry) => idOf(entry) === id);
  if (index === -1) return null;
  return inclusive ? index : index + 1;
};

const ordered = <T>(entries: readonly T[], direction: SortDirection) =>
  direction === "asc" ? entries : [...entries].reverse();

// Without a limit the whole rest is one page, as the history is already in memory.
const pageSize = (limit: number | null, available: number) =>
  limit === null ? available : Math.max(1, Math.floor(limit));

const AT = "at:";
const AFTER = "after:";
const BEFORE = "before:";
