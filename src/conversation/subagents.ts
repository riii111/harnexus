import { createHash } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type HistoryTurn, noteItem } from "../presentation/history.ts";
import {
  closeSubagentTurn,
  declineSubagentTool,
  openSubagentTurn,
  renderSubagentActivity,
  renderSubagentMessage,
  runningSubagentTurn,
  type SubagentThread,
  type SubagentTurn,
  subagentCalls,
} from "../presentation/subagent.ts";
import type { TurnOutcome } from "../presentation/turn.ts";

// The subagents each thread's agent started, kept while the bridge runs; a child's id is made from the Claude thread running it and the agent's task, so the same agent, resumed or seen again, always gets the same thread.
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

  // threadId is the Claude thread whose session runs the agent; an agent another agent started goes under the thread of the agent whose call started it.
  const start = ({
    threadId,
    turnId,
    toolUseId,
    taskId,
    description,
    agentType,
    cwd,
    prompt,
    depth,
  }: {
    threadId: string;
    turnId: string | null;
    toolUseId: string;
    taskId: string;
    description: string | null;
    agentType: string | null;
    cwd: string;
    prompt: string | null;
    depth: number;
  }) => {
    const id = childThreadId(threadId, taskId);
    const at = now();
    const known = children.get(id);
    if (known?.active === true) return;
    const parent = depth <= 1 ? null : callerOf(threadId, toolUseId);
    if (depth > 1 && parent === null) return;
    const parentTurn = parent === null ? undefined : running.get(parent.id);
    const startedIn = parent === null ? turnId : (parentTurn?.turn.id ?? null);
    const child: SubagentThread =
      known === undefined
        ? {
            id,
            rootThreadId: threadId,
            parentThreadId: parent?.id ?? threadId,
            depth: parent === null ? 1 : parent.depth + 1,
            toolUseId,
            taskId,
            nickname: description ?? agentType ?? DEFAULT_NAME,
            role: agentType,
            path: `${parent?.path ?? ROOT_PATH}/${agentName(agentType)}_${childrenOf(parent?.id ?? threadId).length + 1}`,
            turnId: startedIn,
            runs: 1,
            active: true,
            createdAtMs: at,
            updatedAtMs: at,
          }
        : {
            ...known,
            toolUseId,
            turnId: startedIn,
            runs: known.runs + 1,
            active: true,
            updatedAtMs: at,
          };
    children.set(id, child);
    const opened = openSubagentTurn(child, { cwd, prompt }, at);
    running.set(id, opened.turn);
    sendActivity(child, "started", at);
    sendAll(opened.notifications);
  };

  const callerOf = (threadId: string, toolUseId: string) =>
    sessionAgents(threadId).find((child) => {
      const turn = running.get(child.id);
      return turn !== undefined && subagentCalls(turn).includes(toolUseId);
    }) ?? null;

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
    const child = sessionAgents(threadId).find(
      (candidate) => candidate.active && candidate.toolUseId === parent,
    );
    const turn = child === undefined ? undefined : running.get(child.id);
    if (child === undefined || turn === undefined) return;
    const rendered = renderSubagentMessage(turn, sdkMessage, now());
    running.set(child.id, rendered.turn);
    sendAll(rendered.notifications);
  };

  // The prompt asking about an agent's call does not say which agent made it, and only the agent that did holds the call.
  const decline = (threadId: string, toolUseId: string) => {
    for (const child of sessionAgents(threadId)) {
      const turn = running.get(child.id);
      if (turn !== undefined) {
        running.set(child.id, declineSubagentTool(turn, toolUseId));
      }
    }
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
    sendActivity(done, "completed", at);
  };

  // An agent's activity under another agent goes to that agent's newest turn, running or ended, and is kept there for a later read; the app pages a timeline back by position, so an item added to an earlier turn would move entries a cursor it already holds has passed.
  const sendActivity = (
    child: SubagentThread,
    kind: "started" | "completed",
    at: number,
  ) => {
    const parentTurn = running.get(child.parentThreadId);
    if (parentTurn !== undefined) {
      const notifications = renderSubagentActivity(
        child,
        kind,
        at,
        parentTurn.turn.id,
      );
      sendAll(notifications);
      for (const notification of notifications) {
        noteItem(parentTurn.items, notification);
      }
      return;
    }
    const kept = histories.get(child.parentThreadId)?.at(-1);
    const notifications = renderSubagentActivity(
      child,
      kind,
      at,
      kept?.turn.id ?? child.turnId,
    );
    sendAll(notifications);
    if (kept === undefined) return;
    const items = new Map(kept.items.map((entry) => [entry.item.id, entry]));
    for (const notification of notifications) noteItem(items, notification);
    kept.items = [...items.values()];
  };

  // A session that closes stops the agents running in it, the deepest first so each closes before the thread it is listed under.
  const settle = (threadId: string) => {
    const active = sessionAgents(threadId)
      .filter((child) => child.active)
      .sort((a, b) => b.depth - a.depth);
    for (const child of active) {
      complete(threadId, child.taskId, { status: "interrupted" });
    }
  };

  const sessionAgents = (threadId: string) =>
    [...children.values()].filter((child) => child.rootThreadId === threadId);

  const childrenOf = (threadId: string) =>
    [...children.values()].filter((child) => child.parentThreadId === threadId);

  // Every agent below a thread, at any depth, as the app lists them under the thread they descend from.
  const descendantsOf = (threadId: string): SubagentThread[] =>
    childrenOf(threadId).flatMap((child) => [
      child,
      ...descendantsOf(child.id),
    ]);

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
    decline,
    complete,
    settle,
    childrenOf,
    descendantsOf,
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

const ROOT_PATH = "/root";
