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

// Answers the app's requests for a Claude subagent's thread, which the server knows nothing of, from the thread of the Claude session running it.
export const createSubagentRequests = ({
  subagents,
  threads,
  call,
  history,
  send,
}: {
  subagents: Pick<Subagents, "get" | "childrenOf" | "descendantsOf">;
  threads: Threads;
  call: ServerCall;
  history: ChildHistory;
  send: (message: object) => void;
}) => {
  // The app opens the parent before it shows the agents under it, so the agents' threads are made from the answer that opened it without asking the server again.
  const opened = new Map<string, Record<string, unknown>>();

  const remember = (answer: Record<string, unknown>) => {
    const thread = threadOfAnswer(answer);
    if (thread !== null && typeof thread.id === "string") {
      opened.set(thread.id, answer);
    }
  };

  const viewOf = (
    child: SubagentThread,
    parentThread: Record<string, unknown>,
  ) => {
    const model = threads.threadOf(child.rootThreadId)?.model;
    return childThreadView(parentThread, child, {
      model: model ?? String(parentThread.model ?? ""),
      reasoningEffort: shownEffort(threads.effortOf(child.rootThreadId)),
    });
  };

  const parentThreadOf = async (parentThreadId: string) => {
    const known = openedThreadOf(parentThreadId);
    if (known !== null) return known;
    const read = await call("thread/read", {
      threadId: parentThreadId,
      includeTurns: false,
    });
    return read.isOk() ? threadOfAnswer(read.value) : null;
  };

  const openedThreadOf = (parentThreadId: string) => {
    const answer = opened.get(parentThreadId);
    return answer === undefined ? null : threadOfAnswer(answer);
  };

  const parentResumeOf = async (parentThreadId: string) => {
    const known = opened.get(parentThreadId);
    if (known !== undefined) return known;
    // Resuming the parent with no settings of the app's leaves it as it runs.
    const resumed = await call("thread/resume", {
      threadId: parentThreadId,
      excludeTurns: true,
    });
    return resumed.isOk() && isObject(resumed.value) ? resumed.value : null;
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
    const parentThread = await parentThreadOf(child.rootThreadId);
    if (parentThread === null) return unreadable(request);
    const result = { thread: viewOf(child, parentThread) };
    if (request.params.includeTurns !== true) {
      return send({ id: request.id, result });
    }
    const turns = await history(child.id);
    if (turns.isErr()) return unreadable(request);
    send({ id: request.id, result: withTurns(result, turns.value) });
  };

  const answerResume = async (child: SubagentThread, request: AppRequest) => {
    // The agent runs with its parent's settings, so the parent's answer carries them, and the settings the app sends with the agent's resume change nothing.
    const resumed = await parentResumeOf(child.rootThreadId);
    const parentThread = resumed === null ? null : threadOfAnswer(resumed);
    if (resumed === null || parentThread === null) return unreadable(request);
    const turns = await history(child.id);
    if (turns.isErr()) return unreadable(request);
    const thread = viewOf(child, parentThread);
    const result = {
      ...resumed,
      thread,
      model: thread.model,
      reasoningEffort: thread.reasoningEffort,
    };
    send({
      id: request.id,
      result: withResumeHistory(result, turns.value, request.params),
    });
  };

  // Adds the agents a Claude thread's Claude started, which the server never saw, to a list of threads under it.
  const withChildren = (
    result: Record<string, unknown>,
    params: Record<string, unknown>,
  ) => {
    const parentThreadId = listedParentOf(params);
    if (parentThreadId === null || !listsSubagents(params)) return result;
    // The agents all go on the first page, which holds the newest.
    if (params.cursor != null || params.archived === true) return result;
    const children =
      typeof params.ancestorThreadId === "string"
        ? subagents.descendantsOf(parentThreadId)
        : subagents.childrenOf(parentThreadId);
    if (children.length === 0 || !Array.isArray(result.data)) return result;
    const rootThreadId = children[0]?.rootThreadId ?? parentThreadId;
    // The list holds back every later server line until it is answered, so a parent not opened yet lends only what the bridge knows of it rather than waiting on the server.
    const parentThread = openedThreadOf(rootThreadId) ?? {
      id: rootThreadId,
      cwd: threads.threadOf(rootThreadId)?.cwd ?? null,
    };
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
    remember,
  };
};

export type SubagentRequests = ReturnType<typeof createSubagentRequests>;

const listedParentOf = (params: Record<string, unknown>) => {
  if (typeof params.ancestorThreadId === "string")
    return params.ancestorThreadId;
  if (typeof params.parentThreadId === "string") return params.parentThreadId;
  return null;
};

const listsSubagents = (params: Record<string, unknown>) =>
  // No kinds named lists every kind.
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
