import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Result } from "better-result";
import type { HistoryTurn } from "../presentation/history.ts";
import {
  childThreadView,
  type SubagentThread,
  threadOfAnswer,
} from "../presentation/subagent.ts";
import { isObject } from "../runtime/object.ts";
import { withResumeHistory, withTurns } from "./history-request.ts";
import { shownEffort } from "./model-list.ts";
import type { Subagents } from "./subagents.ts";
import type { AppRequest, Thread } from "./thread-request.ts";

type ServerCall = (
  method: string,
  params: unknown,
) => Promise<Result<unknown, { message: string }>>;

type Threads = {
  threadOf: (threadId: string) => Thread | undefined;
  effortOf: (threadId: string) => EffortLevel | null;
};

type ChildHistory = (
  threadId: string,
) => Promise<Result<HistoryTurn[], unknown>>;

// The server knows nothing of a Claude subagent's thread, so the bridge answers every request that names one, building it from its parent's thread as the server reports it.
export const createSubagentRequests = ({
  subagents,
  threads,
  call,
  history,
  send,
}: {
  subagents: Pick<Subagents, "get" | "childrenOf">;
  threads: Threads;
  call: ServerCall;
  history: ChildHistory;
  send: (message: object) => void;
}) => {
  const viewOf = (
    child: SubagentThread,
    parentThread: Record<string, unknown>,
  ) => {
    const model = threads.threadOf(child.parentThreadId)?.model;
    return childThreadView(parentThread, child, {
      model: model ?? String(parentThread.model ?? ""),
      reasoningEffort: shownEffort(threads.effortOf(child.parentThreadId)),
    });
  };

  const parentThreadOf = async (parentThreadId: string) => {
    const read = await call("thread/read", {
      threadId: parentThreadId,
      includeTurns: false,
    });
    return read.isOk() ? threadOfAnswer(read.value) : null;
  };

  const answer = async (method: string, request: AppRequest) => {
    const child = subagents.get(request.params.threadId);
    if (child === undefined) return;
    switch (method) {
      case "thread/read":
        return answerRead(child, request);
      case "thread/resume":
        return answerResume(child, request);
      case "thread/goal/get":
        return send({ id: request.id, result: { goal: null } });
      case "thread/unsubscribe":
        return send({ id: request.id, result: { status: "unsubscribed" } });
      default:
        return refuse(request, method);
    }
  };

  const answerRead = async (child: SubagentThread, request: AppRequest) => {
    const parentThread = await parentThreadOf(child.parentThreadId);
    if (parentThread === null) return unreadable(request);
    const result = { thread: viewOf(child, parentThread) };
    if (request.params.includeTurns !== true) {
      return send({ id: request.id, result });
    }
    const turns = await history(child.id);
    if (turns.isErr()) return unreadable(request);
    send({ id: request.id, result: withTurns(result, turns.value) });
  };

  // The parent is resumed in the agent's place, which leaves it as it was since the app already has it open, and its answer carries the settings the agent runs with.
  const answerResume = async (child: SubagentThread, request: AppRequest) => {
    const { path: _path, history: _history, ...params } = request.params;
    const resumed = await call("thread/resume", {
      ...params,
      threadId: child.parentThreadId,
      excludeTurns: true,
    });
    if (resumed.isErr() || !isObject(resumed.value)) return unreadable(request);
    const parentThread = threadOfAnswer(resumed.value);
    if (parentThread === null) return unreadable(request);
    const turns = await history(child.id);
    if (turns.isErr()) return unreadable(request);
    const thread = viewOf(child, parentThread);
    const result = {
      ...resumed.value,
      thread,
      model: thread.model,
      reasoningEffort: thread.reasoningEffort,
    };
    send({
      id: request.id,
      result: withResumeHistory(result, turns.value, request.params),
    });
  };

  // A list of threads under a Claude thread gains the agents its Claude started, which the server never saw.
  const withChildren = async (
    result: Record<string, unknown>,
    params: Record<string, unknown>,
  ) => {
    const parentThreadId = listedParentOf(params);
    if (parentThreadId === null || !listsSubagents(params)) return result;
    const children = subagents.childrenOf(parentThreadId);
    if (children.length === 0 || !Array.isArray(result.data)) return result;
    const parentThread = await parentThreadOf(parentThreadId);
    if (parentThread === null) return result;
    const listed = new Set(
      result.data.flatMap((thread) =>
        isObject(thread) && typeof thread.id === "string" ? [thread.id] : [],
      ),
    );
    const added = children
      .filter((child) => !listed.has(child.id))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((child) => viewOf(child, parentThread));
    return { ...result, data: [...added, ...result.data] };
  };

  const unreadable = (request: AppRequest) =>
    send({
      id: request.id,
      error: { code: INTERNAL_ERROR, message: UNREADABLE },
    });

  const refuse = (request: AppRequest, method: string) =>
    send({
      id: request.id,
      error: { code: INVALID_REQUEST, message: refusal(method) },
    });

  return {
    isChild: (threadId: unknown) => subagents.get(threadId) !== undefined,
    answer,
    withChildren,
    listedParentOf,
  };
};

export type SubagentRequests = ReturnType<typeof createSubagentRequests>;

// The app lists an agent's threads by the thread they descend from, or by their direct parent.
const listedParentOf = (params: Record<string, unknown>) => {
  if (typeof params.ancestorThreadId === "string")
    return params.ancestorThreadId;
  if (typeof params.parentThreadId === "string") return params.parentThreadId;
  return null;
};

// No kinds named lists every kind.
const listsSubagents = (params: Record<string, unknown>) =>
  !Array.isArray(params.sourceKinds) ||
  params.sourceKinds.length === 0 ||
  params.sourceKinds.includes(SUBAGENT_SOURCE_KIND);

const SUBAGENT_SOURCE_KIND = "subAgentThreadSpawn";

const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;
const UNREADABLE =
  "Harnexus cannot read the thread of this Claude subagent's parent.";
const refusal = (method: string) =>
  `A Claude subagent's thread does not take ${method}.`;
