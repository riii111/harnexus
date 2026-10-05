import { createHash } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentRef,
  type HistoryTurn,
  noteItem,
} from "../presentation/history.ts";
import type {
  AppNotification,
  FileChangeItem,
} from "../presentation/protocol.ts";
import {
  appliedEdits,
  closeSubagentTurn,
  declineSubagentTool,
  openSubagentTurn,
  renderDelegatedEdit,
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
  const runs = new Map<string, Run>();

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
            calls: [toolUseId],
            toolUseId,
            taskId,
            nickname: agentNickname(description, agentType),
            role: agentType,
            path: freePath(
              parent?.path ?? null,
              agentType,
              childrenOf(parent?.id ?? threadId),
            ),
            turnId: startedIn,
            runs: 1,
            active: true,
            createdAtMs: at,
            updatedAtMs: at,
          }
        : {
            ...known,
            calls: [...known.calls, toolUseId],
            toolUseId,
            turnId: startedIn,
            runs: known.runs + 1,
            active: true,
            updatedAtMs: at,
          };
    children.set(id, child);
    const opened = openSubagentTurn(child, { cwd, prompt }, at);
    running.set(id, opened.turn);
    runs.set(toolUseId, {
      agentId: id,
      threadId: parent?.id ?? threadId,
      turnId: startedIn,
      ownTurnId: opened.turn.turn.id,
      edits: [],
    });
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
    const at = now();
    const rendered = renderSubagentMessage(turn, sdkMessage, at);
    running.set(child.id, rendered.turn);
    sendAll(rendered.notifications);
    for (const item of appliedEdits(rendered.notifications)) {
      delegateEdit(child.toolUseId, item, at);
    }
  };

  // The app sums only a turn's own file changes, so an agent's edit is also shown in the turn that made its call, and passed up through the caller's own run.
  const delegateEdit = (call: string, edit: FileChangeItem, at: number) => {
    const run = runs.get(call);
    if (run === undefined || run.edits.some((known) => known.id === edit.id)) {
      return;
    }
    runs.set(call, { ...run, edits: [...run.edits, edit] });
    if (run.turnId !== null) {
      const notifications = renderDelegatedEdit(
        edit,
        { threadId: run.threadId, turnId: run.turnId },
        at,
      );
      sendAll(notifications);
      keepInTurn(run.threadId, run.turnId, notifications);
    }
    const parentCall = [...runs].find(
      ([, other]) =>
        run.turnId !== null &&
        other.agentId === run.threadId &&
        other.ownTurnId === run.turnId,
    )?.[0];
    if (parentCall !== undefined) delegateEdit(parentCall, edit, at);
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

  // An agent's activity under another agent goes to that agent's newest turn, running or ended; the app pages a timeline back by position, so an item added to an earlier turn would move entries a cursor it already holds has passed.
  const sendActivity = (
    child: SubagentThread,
    kind: "started" | "completed",
    at: number,
  ) => {
    const turnId =
      running.get(child.parentThreadId)?.turn.id ??
      histories.get(child.parentThreadId)?.at(-1)?.turn.id ??
      child.turnId;
    const notifications = renderSubagentActivity(child, kind, at, turnId);
    sendAll(notifications);
    if (turnId !== null)
      keepInTurn(child.parentThreadId, turnId, notifications);
  };

  const keepInTurn = (
    agentId: string,
    turnId: string,
    notifications: readonly AppNotification[],
  ) => {
    const turn = running.get(agentId);
    if (turn?.turn.id === turnId) {
      for (const notification of notifications) {
        noteItem(turn.items, notification);
      }
      return;
    }
    const kept = histories
      .get(agentId)
      ?.find((entry) => entry.turn.id === turnId);
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

  // Agents read back from Claude's records after a restart join as ended, keeping any the bridge already knows; one whose path an agent already holds takes the next free one, and the agents under it follow.
  // A parent comes before the agents it started, so each agent is placed under its parent's path as the parent ended up.
  const restore = (
    agents: readonly {
      thread: SubagentThread;
      history: HistoryTurn[];
      edits: ReadonlyMap<string, readonly FileChangeItem[]>;
    }[],
  ) => {
    for (const { thread, history, edits } of agents) {
      if (children.has(thread.id)) continue;
      for (const call of thread.calls) {
        if (runs.has(call)) continue;
        runs.set(call, {
          agentId: thread.id,
          threadId: thread.parentThreadId,
          turnId: null,
          ownTurnId: null,
          edits: [...(edits.get(call) ?? [])],
        });
      }
      const parent = children.get(thread.parentThreadId);
      const siblings = childrenOf(thread.parentThreadId);
      const placed =
        parent === undefined
          ? thread.path
          : `${parent.path}${thread.path.slice(thread.path.lastIndexOf("/"))}`;
      const taken = siblings.some((sibling) => sibling.path === placed);
      children.set(thread.id, {
        ...thread,
        path: taken
          ? freePath(parent?.path ?? null, thread.role, siblings)
          : placed,
      });
      histories.set(thread.id, history);
    }
  };

  // The agent a session's call started, as a parent's history names it.
  const agentRefOf =
    (threadId: string) =>
    (toolUseId: string): AgentRef | undefined => {
      const child = sessionAgents(threadId).find((candidate) =>
        candidate.calls.includes(toolUseId),
      );
      return child === undefined
        ? undefined
        : {
            threadId: child.id,
            path: child.path,
            active: child.active && child.toolUseId === toolUseId,
            edits: runs.get(toolUseId)?.edits ?? [],
          };
    };

  // Undefined for a thread that is no agent's.
  // An agent's activity names the path its agent holds now, which a read-back agent may have changed for one a live agent held.
  const historyOf = (threadId: string): HistoryTurn[] | undefined => {
    if (!children.has(threadId)) return undefined;
    const turn = running.get(threadId);
    return [
      ...(histories.get(threadId) ?? []),
      ...(turn === undefined ? [] : [runningSubagentTurn(turn)]),
    ].map((entry) => ({
      ...entry,
      items: entry.items.map((kept) =>
        kept.item.type === "subAgentActivity"
          ? {
              ...kept,
              item: {
                ...kept.item,
                agentPath:
                  children.get(kept.item.agentThreadId)?.path ??
                  kept.item.agentPath,
              },
            }
          : kept,
      ),
    }));
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
    restore,
    agentRefOf,
    get: (threadId: unknown) =>
      typeof threadId === "string" ? children.get(threadId) : undefined,
  };
};

export type Subagents = ReturnType<typeof createSubagents>;

// One run per call that started or resumed an agent; threadId is the caller, which for a resume may differ from the agent's parent.
type Run = {
  agentId: string;
  threadId: string;
  turnId: string | null;
  ownTurnId: string | null;
  edits: FileChangeItem[];
};

// Shaped as a UUID, as the app's own thread ids are.
export const childThreadId = (parentThreadId: string, taskId: string) => {
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

// An agent's path names its kind and its place among its parent's agents, as Codex numbers them; the first number no sibling holds is used.
export const freePath = (
  parentPath: string | null,
  agentType: string | null,
  siblings: readonly SubagentThread[],
) => {
  const used = new Set(siblings.map((sibling) => sibling.path));
  const base = `${parentPath ?? ROOT_PATH}/${agentName(agentType)}`;
  let number = siblings.length + 1;
  while (used.has(`${base}_${number}`)) number += 1;
  return `${base}_${number}`;
};

export const agentNickname = (
  description: string | null,
  agentType: string | null,
) => description ?? agentType ?? DEFAULT_NAME;

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
