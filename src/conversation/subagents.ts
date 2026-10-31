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

// The subagents Claude runs in each thread, shown in the app as child threads.
export const createSubagents = ({
  send,
  now = Date.now,
}: {
  send: (message: object) => void;
  now?: () => number;
}) => {
  const children = new Map<string, SubagentThread>();
  const running = new Map<string, SubagentTurn>();
  // Each child keeps the turns it ran, so the app can read its thread while the bridge runs.
  const histories = new Map<string, HistoryTurn[]>();
  const runs = new Map<string, Run>();

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
    // Made from the Claude thread and the agent's task, so the same agent, resumed or seen again, always gets the same thread.
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
      threadId: parent?.id ?? threadId,
      turnId: startedIn,
      parentCall: parent?.toolUseId ?? null,
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

  const delegateEdit = (call: string, edit: FileChangeItem, at: number) => {
    const run = runs.get(call);
    if (run === undefined || run.edits.some((known) => known.id === edit.id)) {
      return;
    }
    runs.set(call, { ...run, edits: [...run.edits, edit] });
    // The app sums only a turn's own file changes, so an agent's edit is also shown in the turn that made its call.
    if (run.turnId !== null) {
      const notifications = renderDelegatedEdit(
        edit,
        { threadId: run.threadId, turnId: run.turnId },
        at,
      );
      sendAll(notifications);
      keepInTurn(run.threadId, run.turnId, notifications);
    }
    if (run.parentCall !== null) delegateEdit(run.parentCall, edit, at);
  };

  const decline = (threadId: string, toolUseId: string) => {
    // The prompt does not say which agent made the call, and only the agent that did holds it, so every agent is told.
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

  const sendActivity = (
    child: SubagentThread,
    kind: "started" | "completed",
    at: number,
  ) => {
    // The app pages a timeline back by position, so an activity goes to the parent agent's newest turn, running or ended, rather than an earlier one a cursor has passed.
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

  const settle = (threadId: string) => {
    // The deepest close first, so each agent closes before the thread it is listed under.
    const active = sessionAgents(threadId)
      .filter((child) => child.active)
      .sort((a, b) => b.depth - a.depth);
    for (const child of active) {
      complete(threadId, child.taskId, { status: "interrupted" });
    }
  };

  const forget = (threadId: string) => {
    const agents = sessionAgents(threadId);
    // A thread that returns reads its agents back from Claude's records, as after a restart, so they go unless one still runs.
    if (agents.some((child) => child.active)) return;
    const threads = new Set([threadId, ...agents.map((child) => child.id)]);
    for (const child of agents) {
      children.delete(child.id);
      running.delete(child.id);
      histories.delete(child.id);
    }
    for (const [call, run] of runs) {
      if (threads.has(run.threadId)) runs.delete(call);
    }
  };

  const sessionAgents = (threadId: string) =>
    [...children.values()].filter((child) => child.rootThreadId === threadId);

  const childrenOf = (threadId: string) =>
    [...children.values()].filter((child) => child.parentThreadId === threadId);

  const descendantsOf = (threadId: string): SubagentThread[] =>
    childrenOf(threadId).flatMap((child) => [
      child,
      ...descendantsOf(child.id),
    ]);

  // Adds agents read back from Claude's records after a restart as ended ones.
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
          threadId: thread.parentThreadId,
          turnId: null,
          parentCall: null,
          edits: [...(edits.get(call) ?? [])],
        });
      }
      const parent = children.get(thread.parentThreadId);
      const siblings = childrenOf(thread.parentThreadId);
      // A parent comes before the agents it started, so each agent is placed under its parent's path as the parent ended up.
      const placed =
        parent === undefined
          ? thread.path
          : `${parent.path}${thread.path.slice(thread.path.lastIndexOf("/"))}`;
      // A path an agent already holds is replaced with the next free one, and the agents under it follow.
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
                // A read-back agent may have changed its path for one a live agent held.
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
    forget,
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
// parentCall is the call that started the agent which made this one, taken when the run starts so an edit passes up without a search.
type Run = {
  threadId: string;
  turnId: string | null;
  parentCall: string | null;
  edits: FileChangeItem[];
};

export const childThreadId = (parentThreadId: string, taskId: string) => {
  const hex = createHash("sha256")
    .update(`${parentThreadId}\n${taskId}`)
    .digest("hex");
  // Shaped as a UUID, as the app's own thread ids are.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
};

export const freePath = (
  parentPath: string | null,
  agentType: string | null,
  siblings: readonly SubagentThread[],
) => {
  const used = new Set(siblings.map((sibling) => sibling.path));
  const base = `${parentPath ?? ROOT_PATH}/${agentName(agentType)}`;
  // Numbered by place among the parent's agents, as Codex numbers them.
  let number = siblings.length + 1;
  while (used.has(`${base}_${number}`)) number += 1;
  return `${base}_${number}`;
};

export const agentNickname = (
  description: string | null,
  agentType: string | null,
) => description ?? agentType ?? DEFAULT_NAME;

const agentName = (agentType: string | null) => {
  // The app reads an agent path as Codex writes it, whose names hold only lowercase letters, digits and underscores.
  const name = (agentType ?? DEFAULT_NAME)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return name === "" || name === "root" ? DEFAULT_NAME : name;
};

const DEFAULT_NAME = "agent";

const ROOT_PATH = "/root";
