import { createHash } from "node:crypto";
import {
  renderSubagentCompleted,
  renderSubagentStarted,
  type SubagentThread,
} from "../presentation/subagent.ts";

// The subagents each thread's agent started, kept while the bridge runs; a child's id is made from its parent and the agent's task, so the same agent, resumed or seen again, always gets the same thread.
export const createSubagents = ({
  send,
  now = Date.now,
}: {
  send: (message: object) => void;
  now?: () => number;
}) => {
  const children = new Map<string, SubagentThread>();

  const start = ({
    threadId,
    turnId,
    toolUseId,
    taskId,
    description,
    agentType,
  }: {
    threadId: string;
    turnId: string | null;
    toolUseId: string;
    taskId: string;
    description: string | null;
    agentType: string | null;
  }) => {
    const id = childThreadId(threadId, taskId);
    const at = now();
    const known = children.get(id);
    if (known?.active === true) return;
    const child: SubagentThread =
      known === undefined
        ? {
            id,
            parentThreadId: threadId,
            toolUseId,
            taskId,
            nickname: description ?? agentType ?? DEFAULT_NAME,
            role: agentType,
            path: `/root/${agentName(agentType)}_${childrenOf(threadId).length + 1}`,
            turnId,
            runs: 1,
            active: true,
            createdAtMs: at,
            updatedAtMs: at,
          }
        : {
            ...known,
            turnId,
            runs: known.runs + 1,
            active: true,
            updatedAtMs: at,
          };
    children.set(id, child);
    for (const notification of renderSubagentStarted(child, at)) {
      send(notification);
    }
  };

  const complete = (threadId: string, taskId: string) => {
    const child = children.get(childThreadId(threadId, taskId));
    if (child === undefined || !child.active) return;
    const at = now();
    const done = { ...child, active: false, updatedAtMs: at };
    children.set(child.id, done);
    for (const notification of renderSubagentCompleted(done, at)) {
      send(notification);
    }
  };

  // A session that closes ends the agents running in it.
  const settle = (threadId: string) => {
    for (const child of childrenOf(threadId)) {
      if (child.active) complete(threadId, child.taskId);
    }
  };

  const childrenOf = (threadId: string) =>
    [...children.values()].filter((child) => child.parentThreadId === threadId);

  return {
    start,
    complete,
    settle,
    childrenOf,
    get: (threadId: unknown) =>
      typeof threadId === "string" ? children.get(threadId) : undefined,
  };
};

export type Subagents = ReturnType<typeof createSubagents>;

// Shaped as a UUID, as the app's own thread ids are.
const childThreadId = (parentThreadId: string, taskId: string) => {
  const hex = createHash("sha256")
    .update(`${parentThreadId}\n${taskId}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
};

// The app reads an agent path as Codex writes it, whose names hold only lowercase letters, digits and underscores.
const agentName = (agentType: string | null) => {
  const name = (agentType ?? DEFAULT_NAME)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return name === "" || name === "root" ? DEFAULT_NAME : name;
};

const DEFAULT_NAME = "agent";
