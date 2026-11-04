import type {
  SDKAssistantMessage,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  inProgressTurn,
  itemCompletedAt,
  itemStartedAt,
  subagentActivityItem,
} from "../../../infra/codex/protocol/message-values.ts";
import type {
  AppNotification,
  FileChangeItem,
  ThreadItem,
  Turn,
} from "../../../infra/codex/protocol/messages.ts";
import { isObject } from "../../../lib/object.ts";
import { RESUME_TOOL } from "../subagents/agent-resume.view.ts";
import { RECOVERY_NOTICE } from "../turn/recovery.view.ts";
import {
  AGENT_TOOLS,
  closeTurnUnchecked,
  type Rendered,
  renderNotice,
  renderSdkMessage,
  renderTurnStarted,
  renderUserInput,
  type TurnState,
} from "../turn/turn.view.ts";
import {
  assistantOf,
  INTERRUPTED,
  inputOf,
  isAssistantBody,
  isMetaMessage,
  opensTurn,
  type Prompt,
  promptOf,
  timeOf,
  toolResultsOf,
} from "./message.view.ts";

// turn.items holds the summary a live turn/completed carries; the full items are kept apart for the pages that ask for them.
export type HistoryTurn = { turn: Turn; items: HistoryItem[] };

export type HistoryItem = {
  turnId: string;
  item: ThreadItem;
  startedAtMs: number | null;
  completedAtMs: number | null;
};

// Rebuilds a thread's turns from Claude's record through the live turn renderer, as the turns showed while they ran.
export const buildHistory = (
  messages: readonly SessionMessage[],
  thread: { threadId: string; cwd: string },
  agentThreadOf: (toolUseId: string) => AgentRef | undefined = () => undefined,
): HistoryTurn[] => {
  const turns: HistoryTurn[] = [];
  let replay: Replay | null = null;
  for (const message of messages) {
    // Claude records the tools a subagent called apart from the conversation.
    if (message.parent_tool_use_id !== null || isMetaMessage(message)) continue;
    const at = timeOf(message);
    const body = message.message;
    if (message.type === "user") {
      const prompt = promptOf(body);
      if (prompt === null) {
        if (replay !== null) {
          replay = feed(replay, toolResultsOf(message, body), at);
        }
      } else if (INTERRUPTED.test(prompt.text)) {
        if (replay !== null) replay = interrupt(replay);
      } else if (opensTurn(prompt)) {
        // Each prompt opens a turn, so a steer taken mid-turn appears as a turn of its own.
        if (replay !== null) turns.push(close(replay));
        replay = start(thread, message.uuid, prompt, at);
      }
    } else if (message.type === "assistant" && isAssistantBody(body)) {
      replay ??= start(thread, message.uuid, null, at);
      replay = feed(replay, assistantOf(message, body), at);
      // An agent the conversation started or resumed shows where each of its calls was made, as the activity and edits a live turn gave it.
      replay = noteAgents(replay, body, agentThreadOf, at);
    }
  }

  if (replay !== null) turns.push(close(replay));
  return turns;
};

export const mainRecords = (messages: readonly SessionMessage[]) =>
  // A subagent's records and hidden ones such as a compact summary are left out, as history leaves them out.
  messages.filter(
    (message) =>
      message.parent_tool_use_id === null &&
      !isMetaMessage(message) &&
      (message.type === "user" || message.type === "assistant"),
  );

export const turnOpeningTextOf = (message: SessionMessage) => {
  if (message.type !== "user") return null;
  const prompt = promptOf(message.message);
  return prompt !== null && opensTurn(prompt) ? prompt.text : null;
};

export const endsTurn = (message: SessionMessage) =>
  message.type === "assistant" &&
  isObject(message.message) &&
  message.message.stop_reason === "end_turn";

export type LiveTurn = {
  turnId: string;
  record: string | null;
  startedAtMs: number;
};

export const withLiveTurn = (
  history: readonly HistoryTurn[],
  live: LiveTurn | null,
): HistoryTurn[] => {
  if (live === null) return [...history];
  // A record says nothing of a turn still running, so the turns from its prompt on, steers included, are shown as one turn in progress under the id the live notifications carry.
  const opened =
    live.record === null
      ? -1
      : history.findIndex(
          (entry) => entry.turn.id === `${HISTORY_TURN_PREFIX}${live.record}`,
        );
  const first = history[opened];
  // A turn not yet recorded, one Claude started itself without a prompt, or one a rewind cut off is shown empty.
  if (first === undefined) {
    return [
      ...history,
      {
        turn: inProgressTurn(live.turnId, live.startedAtMs, "summary"),
        items: [],
      },
    ];
  }

  return [
    ...history.slice(0, opened),
    {
      turn: {
        ...first.turn,
        id: live.turnId,
        rootTurnId: live.turnId,
        items: [],
        status: "inProgress",
        error: null,
        completedAt: null,
        durationMs: null,
      },
      items: history
        .slice(opened)
        .flatMap((entry) => entry.items)
        .map((entry) => ({ ...entry, turnId: live.turnId })),
    },
  ];
};

// The notifications that stream history into a thread the app already holds as finished turns, with the ids a later read rebuilds.
export const replayHistory = (
  history: readonly HistoryTurn[],
  threadId: string,
  now: number,
): AppNotification[] =>
  history.flatMap(({ turn, items }): AppNotification[] => {
    const startedAtMs = turn.startedAt === null ? now : turn.startedAt * 1000;
    const completedAtMs =
      turn.completedAt === null ? now : turn.completedAt * 1000;
    const ref = { threadId, turnId: turn.id };
    return [
      {
        method: "turn/started",
        params: {
          threadId,
          turn: {
            ...turn,
            items: [],
            itemsView: "full",
            status: "inProgress",
            completedAt: null,
            durationMs: null,
          },
        },
        emittedAtMs: startedAtMs,
      },
      ...items.flatMap(
        ({
          item,
          startedAtMs: itemStarted,
          completedAtMs: itemCompleted,
        }): AppNotification[] => [
          itemStartedAt(item, ref, itemStarted ?? startedAtMs),
          itemCompletedAt(item, ref, itemCompleted ?? completedAtMs),
        ],
      ),
      {
        method: "turn/completed",
        params: { threadId, turn },
        emittedAtMs: completedAtMs,
      },
    ];
  });

export const buildSubagentHistory = (
  messages: readonly SessionMessage[],
  thread: { threadId: string; cwd: string },
  agentThreadOf: (toolUseId: string) => AgentRef | undefined,
): HistoryTurn[] =>
  buildHistory(
    // A subagent's record is its own conversation, whose messages name the call that started the agent as their parent.
    messages.map((message) => ({ ...message, parent_tool_use_id: null })),
    thread,
    agentThreadOf,
  );

export type AgentRef = {
  threadId: string;
  path: string;
  active: boolean;
  edits: readonly FileChangeItem[];
};

export const delegatedEditIn = (
  edit: FileChangeItem,
  turnId: string,
): FileChangeItem => ({
  ...edit,
  // Agents that resume each other can pass one edit to several turns of a thread, and the app pages items by id.
  id: `${edit.id}-in-${turnId}`,
});

const noteAgents = (
  replay: Replay,
  body: SDKAssistantMessage["message"],
  agentThreadOf: (toolUseId: string) => AgentRef | undefined,
  at: number | null,
): Replay => {
  for (const block of body.content) {
    if (
      block.type !== "tool_use" ||
      !(AGENT_TOOLS.includes(block.name) || block.name === RESUME_TOOL)
    ) {
      continue;
    }

    const agent = agentThreadOf(block.id);
    if (agent === undefined) continue;
    const items: ThreadItem[] = [
      subagentActivityItem(agent, "started", block.id),
      ...agent.edits.map((edit) => delegatedEditIn(edit, replay.state.turnId)),
      ...(agent.active
        ? []
        : [subagentActivityItem(agent, "completed", block.id)]),
    ];
    for (const item of items) {
      replay.items.set(item.id, {
        turnId: replay.state.turnId,
        item,
        startedAtMs: at,
        completedAtMs: at,
      });
    }
  }

  return replay;
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
  prompt: Prompt | null,
  at: number | null,
): Replay => {
  const opened = renderTurnStarted({
    threadId: thread.threadId,
    // A record keeps no bridge turn ids, so turn ids are made from the prompt's record uuid.
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
  const shown = collect(
    replay,
    renderUserInput(replay.state, inputOf(prompt), null, at ?? 0),
  );
  return prompt.recovering
    ? collect(
        shown,
        renderNotice(shown.state, RECOVERY_NOTICE, "commentary", at ?? 0),
      )
    : shown;
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

const close = (replay: Replay): HistoryTurn => {
  const closed = closeTurnUnchecked(
    replay.state,
    // A record says nothing of how its last turn ended unless an interrupt was written, so the rest close as completed.
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

const collect = (replay: Replay, rendered: Rendered): Replay => {
  noteItems(replay.items, rendered.notifications);
  return { ...replay, state: rendered.state };
};

export const noteItems = (
  items: Map<string, HistoryItem>,
  notifications: readonly AppNotification[],
) => {
  for (const notification of notifications) noteItem(items, notification);
};

export const noteItem = (
  items: Map<string, HistoryItem>,
  notification: AppNotification,
) => {
  // A completion replaces the item it closes, since the renderer may complete one item twice to correct a denial.
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
  } else if (notification.method === "item/agentMessage/delta") {
    // The app can read a running turn while its text streams, so a started item takes in the text sent so far.
    const { itemId, delta } = notification.params;
    updateOpenItem(items, itemId, (item) =>
      item.type === "agentMessage"
        ? { ...item, text: item.text + delta }
        : item,
    );
  } else if (notification.method === "item/reasoning/textDelta") {
    const { itemId, delta, contentIndex } = notification.params;
    updateOpenItem(items, itemId, (item) => {
      if (item.type !== "reasoning") return item;
      const content = [...item.content];
      content[contentIndex] = (content[contentIndex] ?? "") + delta;
      return { ...item, content };
    });
  }
};

const updateOpenItem = (
  items: Map<string, HistoryItem>,
  itemId: string,
  update: (item: ThreadItem) => ThreadItem,
) => {
  const entry = items.get(itemId);
  if (entry === undefined || entry.completedAtMs !== null) return;
  items.set(itemId, { ...entry, item: update(entry.item) });
};

const HISTORY_TURN_PREFIX = "harnexus-history-";

export const historyTurnId = (record: string) =>
  `${HISTORY_TURN_PREFIX}${record}`;
