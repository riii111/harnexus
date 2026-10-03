import { isObject } from "../runtime/object.ts";
import type { AppNotification, SubAgentActivityItem } from "./protocol.ts";

// A Claude subagent is shown as a Codex subagent is: a thread of its own under the thread whose Claude started it, which the app lists in its subagents panel.
// turnId is the parent's turn the agent started in, which also carries its completion, as Codex does even once that turn has ended.
export type SubagentThread = {
  id: string;
  parentThreadId: string;
  toolUseId: string;
  taskId: string;
  nickname: string;
  role: string | null;
  path: string;
  turnId: string | null;
  active: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

export const renderSubagentStarted = (
  child: SubagentThread,
  now: number,
): AppNotification[] => [
  ...activity(child, "started", now),
  statusChanged(child, now),
];

export const renderSubagentCompleted = (
  child: SubagentThread,
  now: number,
): AppNotification[] => [
  statusChanged(child, now),
  ...activity(child, "completed", now),
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
        depth: 1,
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
    id: `${child.id}-${kind}`,
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

const statusChanged = (
  child: SubagentThread,
  now: number,
): AppNotification => ({
  method: "thread/status/changed",
  params: { threadId: child.id, status: statusOf(child) },
  emittedAtMs: now,
});

const statusOf = (child: SubagentThread) =>
  child.active
    ? { type: "active" as const, activeFlags: [] as never[] }
    : { type: "idle" as const };

const toSeconds = (ms: number) => Math.floor(ms / 1000);
