import { createHash } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HistoryTurn } from "../presentation/history.ts";
import {
  closeSubagentTurn,
  openSubagentTurn,
  renderSubagentActivity,
  renderSubagentMessage,
  runningSubagentTurn,
  type SubagentThread,
  type SubagentTurn,
} from "../presentation/subagent.ts";
import type { TurnOutcome } from "../presentation/turn.ts";

// The subagents each thread's agent started, kept while the bridge runs; a child's id is made from its parent and the agent's task, so the same agent, resumed or seen again, always gets the same thread.
// Each child keeps the turns it ran, so the app can read its thread while the bridge runs.
export const createSubagents = ({
  send,
  now = Date.now,
}: {
  send: (message: object) => void;
  now?: () => number;
}) => {
  const children = new Map<string, SubagentThread>();
  const running = new Map<string, SubagentTurn>();
  const histories = new Map<string, HistoryTurn[]>();

  const start = ({
    threadId,
    turnId,
    toolUseId,
    taskId,
    description,
    agentType,
    cwd,
    prompt,
  }: {
    threadId: string;
    turnId: string | null;
    toolUseId: string;
    taskId: string;
    description: string | null;
    agentType: string | null;
    cwd: string;
    prompt: string | null;
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
            toolUseId,
            turnId,
            runs: known.runs + 1,
            active: true,
            updatedAtMs: at,
          };
    children.set(id, child);
    const opened = openSubagentTurn(child, { cwd, prompt }, at);
    running.set(id, opened.turn);
    sendAll(renderSubagentActivity(child, "started", at));
    sendAll(opened.notifications);
  };

  // Only what an agent itself says reaches its thread; an agent it starts in turn stays inside its call.
  const message = (threadId: string, sdkMessage: SDKMessage) => {
    if (
      sdkMessage.type !== "assistant" &&
      sdkMessage.type !== "user" &&
      sdkMessage.type !== "stream_event"
    ) {
      return;
    }
    const parent = sdkMessage.parent_tool_use_id;
    if (parent === null) return;
    const child = childrenOf(threadId).find(
      (candidate) => candidate.active && candidate.toolUseId === parent,
    );
    const turn = child === undefined ? undefined : running.get(child.id);
    if (child === undefined || turn === undefined) return;
    const rendered = renderSubagentMessage(turn, sdkMessage, now());
    running.set(child.id, rendered.turn);
    sendAll(rendered.notifications);
  };

  const complete = (threadId: string, taskId: string, outcome: TurnOutcome) => {
    const child = children.get(childThreadId(threadId, taskId));
    if (child === undefined || !child.active) return;
    const at = now();
    const done = { ...child, active: false, updatedAtMs: at };
    children.set(child.id, done);
    const turn = running.get(child.id);
    running.delete(child.id);
    if (turn !== undefined) {
      const closed = closeSubagentTurn(turn, outcome, at);
      histories.set(child.id, [
        ...(histories.get(child.id) ?? []),
        closed.history,
      ]);
      sendAll(closed.notifications);
    }
    sendAll(renderSubagentActivity(done, "completed", at));
  };

  // A session that closes stops the agents running in it.
  const settle = (threadId: string) => {
    for (const child of childrenOf(threadId)) {
      if (child.active) {
        complete(threadId, child.taskId, { status: "interrupted" });
      }
    }
  };

  const childrenOf = (threadId: string) =>
    [...children.values()].filter((child) => child.parentThreadId === threadId);

  // Undefined for a thread that is no agent's.
  const historyOf = (threadId: string): HistoryTurn[] | undefined => {
    if (!children.has(threadId)) return undefined;
    const turn = running.get(threadId);
    return [
      ...(histories.get(threadId) ?? []),
      ...(turn === undefined ? [] : [runningSubagentTurn(turn)]),
    ];
  };

  const sendAll = (notifications: readonly object[]) => {
    for (const notification of notifications) send(notification);
  };

  return {
    start,
    message,
    complete,
    settle,
    childrenOf,
    historyOf,
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
