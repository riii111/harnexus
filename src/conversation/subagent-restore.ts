import { Result, TaggedError } from "better-result";
import type { SubagentRecord } from "../infra/claude/session.ts";
import {
  type AgentRef,
  buildSubagentHistory,
  type HistoryTurn,
  startOfRecord,
} from "../presentation/history.ts";
import type { SubagentThread } from "../presentation/subagent.ts";
import {
  agentNickname,
  childThreadId,
  freePath,
  type Subagents,
} from "./subagents.ts";

type ReadSubagents<E> = (
  sessionId: string,
) => Promise<Result<SubagentRecord[], E>>;

class SubagentsUnrebuilt extends TaggedError("SubagentsUnrebuilt")<{
  cause: unknown;
  message: string;
}> {}

export type SubagentRestoreEvent<E extends { _tag: string }> = {
  event: "claude_subagents_unreadable";
  error: E["_tag"] | SubagentsUnrebuilt["_tag"];
};

// The bridge keeps no agent across a restart, so a Claude thread's agents are read back from Claude's records the first time its conversation is read.
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

  const restore = (threadId: string, sessionId: string, cwd: string) => {
    const key = `${threadId}\n${sessionId}`;
    const running = restored.get(key);
    if (running !== undefined) return running;
    // A record the bridge cannot make sense of leaves the thread's agents out, and a later read tries again.
    const reading = readSubagents(sessionId).then((read) => {
      const rebuilt = read.andThen((records) =>
        Result.try({
          try: () => rebuild(threadId, cwd, records, now()),
          catch: (cause) =>
            new SubagentsUnrebuilt({
              cause,
              message: "cannot rebuild a Claude thread's agents",
            }),
        }),
      );
      if (rebuilt.isErr()) {
        restored.delete(key);
        log({
          event: "claude_subagents_unreadable",
          error: rebuilt.error._tag,
        });
        return;
      }
      subagents.restore(rebuilt.value);
    });
    restored.set(key, reading);
    return reading;
  };

  return { restore };
};

export type SubagentRestore<E extends { _tag: string }> = ReturnType<
  typeof createSubagentRestore<E>
>;

// Agents are numbered under their parent in the order they started, as they were while they ran; an agent another agent started names it in its records, and one that does not, though Claude noted it as nested, is left out.
const rebuild = (
  threadId: string,
  cwd: string,
  records: readonly SubagentRecord[],
  at: number,
): { thread: SubagentThread; history: HistoryTurn[] }[] => {
  const started = records
    .map((record) => ({
      record,
      startedAtMs: startOfRecord(record.messages) ?? at,
      parentAgentId: record.messages[0]?.parent_agent_id ?? null,
    }))
    .sort((a, b) => a.startedAtMs - b.startedAtMs);
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
  const refOf = (toolUseId: string): AgentRef | undefined => {
    const agent = [...threads.values()].find(
      (thread) => thread.toolUseId === toolUseId,
    );
    return agent === undefined
      ? undefined
      : { threadId: agent.id, path: agent.path, active: false };
  };
  return started.flatMap(({ record }) => {
    const thread = threads.get(record.agentId);
    if (thread === undefined) return [];
    const history = buildSubagentHistory(
      record.messages,
      { threadId: thread.id, cwd },
      refOf,
    );
    return [
      { thread: { ...thread, runs: Math.max(history.length, 1) }, history },
    ];
  });
};
