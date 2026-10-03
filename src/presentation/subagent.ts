import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isObject } from "../runtime/object.ts";
import { type HistoryItem, type HistoryTurn, noteItem } from "./history.ts";
import type {
  AppNotification,
  SubAgentActivityItem,
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
// rootThreadId is the Claude thread whose session runs the agent, and parentThreadId that thread or the agent's thread whose agent started this one, depth levels below the root.
// spawnToolUseId is the call that first started the agent and toolUseId the one that last did, as a resumed agent runs under a call of its own.
// turnId is the parent's turn the agent last started in, which also carries its completion, as Codex does even once that turn has ended; runs counts its starts, since Claude can resume an agent that finished.
export type SubagentThread = {
  id: string;
  rootThreadId: string;
  parentThreadId: string;
  depth: number;
  spawnToolUseId: string;
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

// The agent's own turn carries its thread's status, as a Codex subagent's does.
export const renderSubagentActivity = (
  child: SubagentThread,
  kind: SubAgentActivityItem["kind"],
  now: number,
): AppNotification[] => activity(child, kind, now);

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

// Only the server's thread object is kept from its answer, since the rest of a thread/read answer names nothing else.
export const threadOfAnswer = (answer: unknown) =>
  isObject(answer) && isObject(answer.thread) ? answer.thread : null;

const activity = (
  child: SubagentThread,
  kind: SubAgentActivityItem["kind"],
  now: number,
): AppNotification[] => {
  if (child.turnId === null) return [];
  const item: SubAgentActivityItem = {
    type: "subAgentActivity",
    id: `${child.id}-${kind}-${child.runs}`,
    kind,
    agentThreadId: child.id,
    agentPath: child.path,
  };
  const ref = { threadId: child.parentThreadId, turnId: child.turnId };
  return [
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
};

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

// A call the user refused for the agent closes as declined in the agent's thread, as it does in the turn that asked.
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

// The calls an agent made in its turn, so an agent one of them started is placed under this one.
export const subagentCalls = (turn: SubagentTurn) =>
  Object.keys(turn.state.tools);

// A turn still running reads as one in progress with the items it has so far, which the app reads apart from its summary.
export const runningSubagentTurn = (turn: SubagentTurn): HistoryTurn => ({
  turn: { ...turn.turn, itemsView: "notLoaded" },
  items: [...turn.items.values()],
});

// The turn's items are kept in one map for the turn's life, since an agent's turn can stream many messages.
const collect = (
  turn: SubagentTurn,
  notifications: readonly AppNotification[],
): SubagentTurn => {
  for (const notification of notifications) noteItem(turn.items, notification);
  return turn;
};
