import type {
  AppNotification,
  SubAgentActivityItem,
  ThreadItem,
  Turn,
} from "./protocol.ts";

export const toSeconds = (ms: number) => Math.floor(ms / 1000);

export const inProgressTurn = (
  turnId: string,
  startedAtMs: number,
  itemsView: Turn["itemsView"],
): Turn => ({
  id: turnId,
  rootTurnId: turnId,
  items: [],
  itemsView,
  status: "inProgress",
  error: null,
  startedAt: toSeconds(startedAtMs),
  completedAt: null,
  durationMs: null,
});

export const itemStartedAt = (
  item: ThreadItem,
  ref: { threadId: string; turnId: string },
  at: number,
): AppNotification => ({
  method: "item/started",
  params: {
    item,
    threadId: ref.threadId,
    turnId: ref.turnId,
    startedAtMs: at,
  },
  emittedAtMs: at,
});

export const itemCompletedAt = (
  item: ThreadItem,
  ref: { threadId: string; turnId: string },
  at: number,
): AppNotification => ({
  method: "item/completed",
  params: {
    item,
    threadId: ref.threadId,
    turnId: ref.turnId,
    completedAtMs: at,
  },
  emittedAtMs: at,
});

// A history rebuilt from the record and the live turn must name an activity alike, or the app shows it twice after a reload.
export const subagentActivityItem = (
  agent: { threadId: string; path: string },
  kind: SubAgentActivityItem["kind"],
  toolUseId: string,
): SubAgentActivityItem => ({
  type: "subAgentActivity",
  id: `${agent.threadId}-${kind}-${toolUseId}`,
  kind,
  agentThreadId: agent.threadId,
  agentPath: agent.path,
});
