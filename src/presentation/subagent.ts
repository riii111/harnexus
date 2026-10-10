import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isObject } from "../runtime/object.ts";
import {
  delegatedEditIn,
  type HistoryItem,
  type HistoryTurn,
  noteItem,
} from "./history.ts";
import type {
  AppNotification,
  FileChangeItem,
  SubAgentActivityItem,
  ThreadItem,
  Turn,
} from "./protocol.ts";
import {
  closeTurn,
  markToolDeclined,
  renderSdkMessage,
  renderTurnStarted,
  renderUserInput,
  type TurnOutcome,
  type TurnState,
} from "./turn.ts";

// A Claude subagent is shown as a Codex subagent is: a thread of its own under the thread whose agent started it, which the app lists in its subagents panel.
// A resumed agent runs under a call of its own, and each run's activity is named after its call, so a history rebuilt from the record names it as the live turn did.
// The parent's turn the agent last started in carries its completion, as Codex does even once that turn has ended, unless the parent is an agent whose newest turn is a later one.
export type SubagentThread = {
  id: string;
  rootThreadId: string;
  parentThreadId: string;
  depth: number;
  calls: string[];
  toolUseId: string;
  taskId: string;
  nickname: string;
  role: string | null;
  path: string;
  turnId: string | null;
  runs: number;
  active: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

// The agent's own turn carries its thread's status, as a Codex subagent's does; turnId is the parent's turn that shows it, the one the agent started in unless named.
export const renderSubagentActivity = (
  child: SubagentThread,
  kind: SubAgentActivityItem["kind"],
  now: number,
  turnId: string | null = child.turnId,
): AppNotification[] => {
  if (turnId === null) return [];
  const item: SubAgentActivityItem = {
    type: "subAgentActivity",
    id: subagentActivityId(child.id, kind, child.toolUseId),
    kind,
    agentThreadId: child.id,
    agentPath: child.path,
  };
  return shownAt(item, { threadId: child.parentThreadId, turnId }, now);
};

export const renderDelegatedEdit = (
  edit: FileChangeItem,
  ref: { threadId: string; turnId: string },
  now: number,
): AppNotification[] => shownAt(delegatedEditIn(edit, ref.turnId), ref, now);

export const appliedEdits = (
  notifications: readonly AppNotification[],
): FileChangeItem[] =>
  notifications.flatMap((notification) =>
    notification.method === "item/completed" &&
    isAppliedEdit(notification.params.item)
      ? [notification.params.item]
      : [],
  );

export const isAppliedEdit = (item: ThreadItem): item is FileChangeItem =>
  item.type === "fileChange" && item.status === "completed";

const shownAt = (
  item: ThreadItem,
  ref: { threadId: string; turnId: string },
  now: number,
): AppNotification[] => [
  {
    method: "item/started",
    params: { item, ...ref, startedAtMs: now },
    emittedAtMs: now,
  },
  {
    method: "item/completed",
    params: { item, ...ref, completedAtMs: now },
    emittedAtMs: now,
  },
];

// The parent's own thread, as the server reports it, gives the fields only the server knows, such as its directory and environment, which the agent shares.
export const childThreadView = (
  parentThread: Record<string, unknown>,
  child: SubagentThread,
  shown: { model: string; reasoningEffort: string | null },
) => ({
  ...parentThread,
  id: child.id,
  sessionId: child.parentThreadId,
  forkedFromId: child.parentThreadId,
  parentThreadId: child.parentThreadId,
  preview: "",
  name: null,
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  model: shown.model,
  reasoningEffort: shown.reasoningEffort,
  createdAt: toSeconds(child.createdAtMs),
  updatedAt: toSeconds(child.updatedAtMs),
  recencyAt: toSeconds(child.createdAtMs),
  status: statusOf(child),
  source: {
    subAgent: {
      thread_spawn: {
        parent_thread_id: child.parentThreadId,
        depth: child.depth,
        agent_path: child.path,
        agent_nickname: child.nickname,
        agent_role: child.role,
      },
    },
  },
  canAcceptDirectInput: false,
  threadSource: "subagent",
  agentNickname: child.nickname,
  agentRole: child.role,
  turns: [],
});

export const threadOfAnswer = (answer: unknown) =>
  isObject(answer) && isObject(answer.thread) ? answer.thread : null;

export const subagentActivityId = (
  agentThreadId: string,
  kind: SubAgentActivityItem["kind"],
  toolUseId: string,
) => `${agentThreadId}-${kind}-${toolUseId}`;

const statusOf = (child: SubagentThread) =>
  child.active
    ? { type: "active" as const, activeFlags: [] as never[] }
    : { type: "idle" as const };

const toSeconds = (ms: number) => Math.floor(ms / 1000);

// A subagent's thread runs one turn for each time the agent runs, holding what the agent did; Claude sends no prompt of the agent's, so the task's own prompt opens the turn.
export type SubagentTurn = {
  state: TurnState;
  turn: Turn;
  items: Map<string, HistoryItem>;
};

export const openSubagentTurn = (
  child: SubagentThread,
  { cwd, prompt }: { cwd: string; prompt: string | null },
  now: number,
): { turn: SubagentTurn; notifications: AppNotification[] } => {
  const opened = renderTurnStarted({
    threadId: child.id,
    turnId: `${child.id}-turn-${child.runs}`,
    cwd,
    now,
  });
  const typed =
    prompt === null
      ? { state: opened.state, notifications: [] }
      : renderUserInput(
          opened.state,
          [{ type: "text", text: prompt, text_elements: [] }],
          null,
          now,
        );
  const notifications = [...opened.notifications, ...typed.notifications];
  return {
    turn: collect(
      { state: typed.state, turn: opened.turn, items: new Map() },
      notifications,
    ),
    notifications,
  };
};

// The agent's messages name the call that started it as their parent; in its own thread they are the conversation itself.
export const renderSubagentMessage = (
  turn: SubagentTurn,
  message: SDKMessage,
  now: number,
): { turn: SubagentTurn; notifications: AppNotification[] } => {
  const rendered = renderSdkMessage(
    turn.state,
    { ...message, parent_tool_use_id: null } as SDKMessage,
    now,
  );
  return {
    turn: collect({ ...turn, state: rendered.state }, rendered.notifications),
    notifications: rendered.notifications,
  };
};

export const declineSubagentTool = (
  turn: SubagentTurn,
  toolUseId: string,
): SubagentTurn => ({
  ...turn,
  state: markToolDeclined(turn.state, toolUseId),
});

export const closeSubagentTurn = (
  turn: SubagentTurn,
  outcome: TurnOutcome,
  now: number,
): { history: HistoryTurn; notifications: AppNotification[] } => {
  const closed = closeTurn(turn.state, outcome, now);
  const { items } = collect(turn, closed.notifications);
  return {
    history: { turn: closed.turn, items: [...items.values()] },
    notifications: closed.notifications,
  };
};

export const subagentCalls = (turn: SubagentTurn) =>
  Object.keys(turn.state.tools);

// A turn still running reads as one in progress with the items it has so far, which the app reads apart from its summary.
export const runningSubagentTurn = (turn: SubagentTurn): HistoryTurn => ({
  turn: { ...turn.turn, itemsView: "notLoaded" },
  items: [...turn.items.values()],
});

// The turn's items are kept in one map for the turn's life, since an agent's turn can stream many messages.
// The app can read a running turn while its text streams, so a started item takes in the text sent so far; its completion then replaces it with the whole text.
const collect = (
  turn: SubagentTurn,
  notifications: readonly AppNotification[],
): SubagentTurn => {
  for (const notification of notifications) {
    noteItem(turn.items, notification);
    if (notification.method === "item/agentMessage/delta") {
      const { itemId, delta } = notification.params;
      updateOpenItem(turn.items, itemId, (item) =>
        item.type === "agentMessage"
          ? { ...item, text: item.text + delta }
          : item,
      );
    } else if (notification.method === "item/reasoning/textDelta") {
      const { itemId, delta, contentIndex } = notification.params;
      updateOpenItem(turn.items, itemId, (item) => {
        if (item.type !== "reasoning") return item;
        const content = [...item.content];
        content[contentIndex] = (content[contentIndex] ?? "") + delta;
        return { ...item, content };
      });
    }
  }
  return turn;
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
