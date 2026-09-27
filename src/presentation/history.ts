import type {
  SDKAssistantMessage,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isObject } from "../runtime/object.ts";
import type { AppNotification, ThreadItem, Turn } from "./protocol.ts";
import { withoutSkillBodies } from "./skill-prompt.ts";
import {
  closeTurn,
  type Rendered,
  renderSdkMessage,
  renderTurnStarted,
  renderUserInput,
  type TurnState,
} from "./turn.ts";

// turn.items holds the summary a live turn/completed carries; the full items are kept apart for the pages that ask for them.
export type HistoryTurn = { turn: Turn; items: HistoryItem[] };

export type HistoryItem = {
  turnId: string;
  item: ThreadItem;
  startedAtMs: number | null;
  completedAtMs: number | null;
};

// The record is replayed through the live turn renderer, so a reopened thread shows the same items the turn showed while it ran.
// Each prompt opens a turn, so a steer taken mid-turn appears as a turn of its own, and a record keeps no bridge turn ids, so turn ids are made from the prompt's record uuid.
export const buildHistory = (
  messages: readonly SessionMessage[],
  thread: { threadId: string; cwd: string },
): HistoryTurn[] => {
  const turns: HistoryTurn[] = [];
  let replay: Replay | null = null;
  for (const message of messages) {
    if (message.parent_tool_use_id !== null || isMetaMessage(message)) continue;
    const at = timeOf(message);
    const body = message.message;
    if (message.type === "user") {
      const prompt = promptOf(body);
      if (prompt === null) {
        if (replay !== null) {
          replay = feed(replay, toolResultsOf(message, body), at);
        }
      } else if (INTERRUPTED.test(prompt)) {
        if (replay !== null) replay = interrupt(replay);
      } else {
        if (replay !== null) turns.push(close(replay));
        replay = start(thread, message.uuid, withoutSkillBodies(prompt), at);
      }
    } else if (message.type === "assistant" && isAssistantBody(body)) {
      replay ??= start(thread, message.uuid, null, at);
      replay = feed(replay, assistantOf(message, body), at);
    }
  }
  if (replay !== null) turns.push(close(replay));
  return turns;
};

type Replay = {
  state: TurnState;
  items: Map<string, HistoryItem>;
  interrupted: boolean;
  firstAt: number | null;
  lastAt: number | null;
};

const interrupt = (replay: Replay): Replay => ({
  ...replay,
  interrupted: true,
});

const start = (
  thread: { threadId: string; cwd: string },
  uuid: string,
  prompt: string | null,
  at: number | null,
): Replay => {
  const opened = renderTurnStarted({
    threadId: thread.threadId,
    turnId: `${HISTORY_TURN_PREFIX}${uuid}`,
    cwd: thread.cwd,
    now: at ?? 0,
  });
  const replay = collect(
    {
      state: opened.state,
      items: new Map(),
      interrupted: false,
      firstAt: at,
      lastAt: at,
    },
    opened,
  );
  if (prompt === null) return replay;
  const input = [{ type: "text", text: prompt, text_elements: [] }];
  return collect(replay, renderUserInput(replay.state, input, null, at ?? 0));
};

const feed = (
  replay: Replay,
  message: SDKUserMessage | SDKAssistantMessage,
  at: number | null,
): Replay => {
  const timed = {
    ...replay,
    firstAt: replay.firstAt ?? at,
    lastAt: at ?? replay.lastAt,
  };
  return collect(
    timed,
    renderSdkMessage(timed.state, message, timed.lastAt ?? 0),
  );
};

// A record says nothing of how its last turn ended unless an interrupt was written, so the rest close as completed.
const close = (replay: Replay): HistoryTurn => {
  const closed = closeTurn(
    replay.state,
    { status: replay.interrupted ? "interrupted" : "completed" },
    replay.lastAt ?? 0,
  );
  const { items } = collect(replay, closed);
  const untimed = replay.firstAt === null;
  return {
    turn: untimed
      ? { ...closed.turn, startedAt: null, completedAt: null, durationMs: null }
      : closed.turn,
    items: [...items.values()].map((entry) =>
      untimed ? { ...entry, startedAtMs: null, completedAtMs: null } : entry,
    ),
  };
};

// A completion replaces the item it closes, since the renderer may complete one item twice to correct a denial.
const collect = (replay: Replay, rendered: Rendered): Replay => {
  const items = new Map(replay.items);
  for (const notification of rendered.notifications) {
    noteItem(items, notification);
  }
  return { ...replay, state: rendered.state, items };
};

const noteItem = (
  items: Map<string, HistoryItem>,
  notification: AppNotification,
) => {
  if (notification.method === "item/started") {
    items.set(notification.params.item.id, {
      turnId: notification.params.turnId,
      item: notification.params.item,
      startedAtMs: notification.params.startedAtMs,
      completedAtMs: null,
    });
  } else if (notification.method === "item/completed") {
    const { item, turnId, completedAtMs } = notification.params;
    items.set(item.id, {
      turnId,
      item,
      startedAtMs: items.get(item.id)?.startedAtMs ?? completedAtMs,
      completedAtMs,
    });
  }
};

// A user record carrying tool results continues the turn; any other user record is a prompt.
const promptOf = (body: unknown): string | null => {
  if (!isObject(body)) return null;
  const { content } = body;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  if (
    content.some((block) => isObject(block) && block.type === "tool_result")
  ) {
    return null;
  }
  return content
    .flatMap((block) =>
      isObject(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
};

// The SDK types a record's message as unknown, so only a message with the fields the renderer reads is replayed.
const isAssistantBody = (
  body: unknown,
): body is SDKAssistantMessage["message"] =>
  isObject(body) && typeof body.id === "string" && Array.isArray(body.content);

const assistantOf = (
  message: SessionMessage,
  body: SDKAssistantMessage["message"],
): SDKAssistantMessage => ({
  type: "assistant",
  message: body,
  parent_tool_use_id: null,
  uuid: message.uuid as SDKAssistantMessage["uuid"],
  session_id: message.session_id,
});

// promptOf has already found tool results in this content.
const toolResultsOf = (
  message: SessionMessage,
  body: unknown,
): SDKUserMessage => ({
  type: "user",
  message: body as SDKUserMessage["message"],
  parent_tool_use_id: null,
  session_id: message.session_id,
});

// The SDK returns these fields without typing them; a compact summary and other hidden records carry is_meta.
const isMetaMessage = (message: SessionMessage) =>
  (message as { is_meta?: unknown }).is_meta === true;

const timeOf = (message: SessionMessage) => {
  const stamp = (message as { timestamp?: unknown }).timestamp;
  const ms = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
};

const HISTORY_TURN_PREFIX = "harnexus-history-";

// Claude Code writes these as user messages when a turn is stopped.
const INTERRUPTED = /^\[Request interrupted by user/;
