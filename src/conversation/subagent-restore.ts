import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Result } from "better-result";
import type { SubagentRecord } from "../infra/claude/session.ts";
import {
  type AgentRef,
  type AgentResume,
  buildSubagentHistory,
  findAgentResumes,
  type HistoryTurn,
  startOfRecord,
} from "../presentation/history.ts";
import type { FileChangeItem } from "../presentation/protocol.ts";
import {
  isAppliedEdit,
  type SubagentThread,
} from "../presentation/subagent.ts";
import { isObject } from "../runtime/object.ts";
import {
  agentNickname,
  childThreadId,
  freePath,
  type Subagents,
} from "./subagents.ts";

type ReadSubagents<E> = (
  sessionId: string,
) => Promise<Result<SubagentRecord[], E>>;

export type SubagentRestoreEvent<E extends { _tag: string }> = {
  event: "claude_subagents_unreadable";
  error: E["_tag"];
};

// The bridge keeps no agent across a restart, so a Claude thread's agents are read back from Claude's records the first time its conversation is read; messages is the conversation's own record, whose calls may have resumed its agents.
export const createSubagentRestore = <E extends { _tag: string }>({
  subagents,
  readSubagents,
  log,
  now = Date.now,
}: {
  subagents: Pick<Subagents, "restore">;
  readSubagents: ReadSubagents<E>;
  log: (event: SubagentRestoreEvent<E>) => void;
  now?: () => number;
}) => {
  const restored = new Map<string, Promise<void>>();

  const restore = (
    threadId: string,
    sessionId: string,
    cwd: string,
    messages: readonly SessionMessage[],
  ) => {
    const key = `${threadId}\n${sessionId}`;
    const running = restored.get(key);
    if (running !== undefined) return running;
    // Records that cannot be read leave the thread's agents out, and a later read tries again.
    const reading = readSubagents(sessionId).then((read) => {
      if (read.isErr()) {
        restored.delete(key);
        log({ event: "claude_subagents_unreadable", error: read.error._tag });
        return;
      }
      subagents.restore(rebuild(threadId, cwd, read.value, messages, now()));
    });
    restored.set(key, reading);
    // A fault in the bridge reaches the caller as it is rather than as a record it could not read, and is not kept, so a later read tries again.
    reading.catch(() => {
      if (restored.get(key) === reading) restored.delete(key);
    });
    return reading;
  };

  return { restore };
};

export type SubagentRestore<E extends { _tag: string }> = ReturnType<
  typeof createSubagentRestore<E>
>;

// Agents are numbered under their parent in the order they started, as they were while they ran; an agent another agent started names it in its records, and one that does not, though Claude noted it as nested, is left out.
// Records Claude kept may disagree with each other, so an agent whose id or starting call an earlier agent already has is left out.
// Each agent's runs are its starting call and then each call that resumed it, in the order they were made, so the history of whichever conversation made a call shows the agent's activity and edits there.
const rebuild = (
  threadId: string,
  cwd: string,
  records: readonly SubagentRecord[],
  messages: readonly SessionMessage[],
  at: number,
): {
  thread: SubagentThread;
  history: HistoryTurn[];
  edits: ReadonlyMap<string, readonly FileChangeItem[]>;
}[] => {
  const started = usable(
    records
      .map((record) => ({
        record,
        startedAtMs: startOfRecord(record.messages) ?? at,
        parentAgentId: record.messages[0]?.parent_agent_id ?? null,
      }))
      .sort((a, b) => a.startedAtMs - b.startedAtMs),
  );
  const threads = new Map<string, SubagentThread>();
  for (const { record, startedAtMs, parentAgentId } of started) {
    const parent =
      parentAgentId === null ? undefined : threads.get(parentAgentId);
    if (parentAgentId !== null && parent === undefined) continue;
    if (parentAgentId === null && record.depth > 1) continue;
    const parentThreadId = parent?.id ?? threadId;
    const siblings = [...threads.values()].filter(
      (thread) => thread.parentThreadId === parentThreadId,
    );
    threads.set(record.agentId, {
      id: childThreadId(threadId, record.agentId),
      rootThreadId: threadId,
      parentThreadId,
      depth: parent === undefined ? 1 : parent.depth + 1,
      calls: [record.toolUseId],
      toolUseId: record.toolUseId,
      taskId: record.agentId,
      nickname: agentNickname(record.description, record.agentType),
      role: record.agentType,
      path: freePath(parent?.path ?? null, record.agentType, siblings),
      turnId: null,
      runs: 1,
      active: false,
      createdAtMs: startedAtMs,
      updatedAtMs: startedAtMs,
    });
  }
  const resumes = resumesOf(
    [messages, ...started.map(({ record }) => record.messages)],
    started.map(({ record }) => record),
  );
  const madeAt = new Map<string, number | null>();
  for (const [agentId, calls] of resumes) {
    const thread = threads.get(agentId);
    if (thread === undefined) continue;
    for (const call of calls) madeAt.set(call.toolUseId, call.at);
    const all = [...thread.calls, ...calls.map((call) => call.toolUseId)];
    threads.set(agentId, {
      ...thread,
      calls: all,
      toolUseId: all.at(-1) ?? thread.toolUseId,
    });
  }
  const edits = new Map<string, FileChangeItem[]>();
  const refOf = (toolUseId: string): AgentRef | undefined => {
    const agent = [...threads.values()].find((thread) =>
      thread.calls.includes(toolUseId),
    );
    return agent === undefined
      ? undefined
      : {
          threadId: agent.id,
          path: agent.path,
          active: false,
          edits: edits.get(toolUseId) ?? [],
        };
  };
  // An agent's history shows the edits of the agents it started or resumed, so those agents are built first; a cycle of resumes builds with what is known so far.
  const histories = new Map<string, HistoryTurn[]>();
  const building = new Set<string>();
  const build = (thread: SubagentThread) => {
    if (histories.has(thread.taskId) || building.has(thread.taskId)) return;
    building.add(thread.taskId);
    const record = started.find(
      (entry) => entry.record.agentId === thread.taskId,
    )?.record;
    if (record === undefined) return;
    for (const call of callsIn(record.messages)) {
      const callee = [...threads.values()].find(
        (other) => other !== thread && other.calls.includes(call),
      );
      if (callee !== undefined) build(callee);
    }
    const history = buildSubagentHistory(
      record.messages,
      { threadId: thread.id, cwd },
      refOf,
    );
    histories.set(thread.taskId, history);
    for (const [call, applied] of editsByRun(history, thread.calls, madeAt)) {
      edits.set(call, applied);
    }
  };
  for (const thread of threads.values()) build(thread);
  return started.flatMap(({ record }) => {
    const thread = threads.get(record.agentId);
    const history = histories.get(record.agentId);
    if (thread === undefined || history === undefined) return [];
    return [
      {
        thread: { ...thread, runs: Math.max(history.length, 1) },
        history,
        edits: new Map(
          thread.calls.map((call) => [call, edits.get(call) ?? []]),
        ),
      },
    ];
  });
};

// A record does not say which call each of an agent's turns ran under, so a turn is taken as run by the last call made before it started, and by the starting call when no resume came before it.
const editsByRun = (
  history: readonly HistoryTurn[],
  calls: readonly string[],
  madeAt: ReadonlyMap<string, number | null>,
) => {
  const byCall = new Map<string, FileChangeItem[]>(
    calls.map((call) => [call, []]),
  );
  for (const { items } of history) {
    const startedAt = items[0]?.startedAtMs ?? null;
    const call = [...calls]
      .reverse()
      .find(
        (candidate) =>
          candidate === calls[0] ||
          (startedAt !== null &&
            (madeAt.get(candidate) ?? Number.POSITIVE_INFINITY) <= startedAt),
      );
    if (call === undefined) continue;
    byCall
      .get(call)
      ?.push(...items.map((entry) => entry.item).filter(isAppliedEdit));
  }
  return byCall;
};

const callsIn = (messages: readonly SessionMessage[]) =>
  messages.flatMap((message) => {
    const body = message.message;
    if (message.type !== "assistant" || !isObject(body)) return [];
    const content = Array.isArray(body.content) ? body.content : [];
    return content.flatMap((block) =>
      isObject(block) &&
      block.type === "tool_use" &&
      typeof block.id === "string"
        ? [block.id]
        : [],
    );
  });

const usable = <T extends { record: SubagentRecord }>(
  started: readonly T[],
) => {
  const agentIds = new Set<string>();
  const calls = new Set<string>();
  return started.filter(({ record }) => {
    if (agentIds.has(record.agentId) || calls.has(record.toolUseId)) {
      return false;
    }
    agentIds.add(record.agentId);
    calls.add(record.toolUseId);
    return true;
  });
};

// The calls that resumed each agent, in the order they were made; a call names the agent it resumed by its id, or as the call addressed it, by the agent's id or the name it was started with, with any reference Claude appended to the name left off.
const resumesOf = (
  conversations: readonly (readonly SessionMessage[])[],
  records: readonly SubagentRecord[],
) => {
  const byAddress = new Map<string, string>();
  for (const record of records) {
    if (record.name !== null && !byAddress.has(record.name)) {
      byAddress.set(record.name, record.agentId);
    }
  }
  for (const record of records) byAddress.set(record.agentId, record.agentId);
  const resumed = new Map<string, AgentResume[]>();
  const found: AgentResume[] = conversations
    .flatMap((messages) => findAgentResumes(messages))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  for (const resume of found) {
    const agentId =
      resume.resumedAgentId ??
      byAddress.get(resume.recipient.replace(APPENDED_REFERENCE, ""));
    if (agentId === undefined) continue;
    resumed.set(agentId, [...(resumed.get(agentId) ?? []), resume]);
  }
  return resumed;
};

// Claude may ask for an agent's name to be sent with the reference it listed, as "name [ref]".
const APPENDED_REFERENCE = /\s+\[[^\]]*\]$/;
