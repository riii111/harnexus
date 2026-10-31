import type { EffortRule, ModelCatalog } from "../infra/claude/models.ts";
import {
  type HistoryTurn,
  type LiveTurn,
  withLiveTurn,
} from "../presentation/history.ts";
import { isObject } from "../runtime/object.ts";
import {
  type createHistoryRequests,
  endsLive,
  shortId,
  withLiveStatus,
  withResumeHistory,
  withTurns,
} from "./history-request.ts";
import { encode } from "./json-line.ts";
import { shownEffort, withClaudeModels } from "./model-list.ts";
import type { createCompatibility } from "./route-compatibility.ts";
import type { createSideChats, Opened } from "./side-chat.ts";
import type { SubagentRequests } from "./subagent-requests.ts";
import type { Thread } from "./thread-request.ts";
import type { ThreadValues } from "./thread-values.ts";
import type { ThreadEnd } from "./turn-runtime.ts";

type History = ReturnType<typeof createHistoryRequests>;

type SideChats = ReturnType<typeof createSideChats>;

type ThreadOpen = {
  kind: "threadOpen";
  createdModel: string | null;
  forkOf: string | null;
  history: ReturnType<History["load"]> | null;
  params: Record<string, unknown>;
  sideChat: Opened | null;
};

// createdModel is the Claude model a thread/start asked for, which the server never sees; history is the Claude thread's record being read while the server opens the thread; sideChat is where the main conversation stood when a side chat of a Claude thread opened.
export type Pending =
  | { kind: "initialize" }
  | { kind: "modelList" }
  | ThreadOpen
  | {
      kind: "threadRead";
      threadId: string;
      history: ReturnType<History["load"]> | null;
    }
  | { kind: "childList"; params: Record<string, unknown> }
  | { kind: "threadEnd"; threadId: string; ended: ThreadEnd };

export type ResponseEvent =
  | { event: "model_id_collision"; model: string }
  | {
      event: "claude_history_served";
      method: "thread/resume" | "thread/read";
      thread: string;
      excludeTurns: boolean;
      initialPage: boolean;
      picked: boolean;
      turns: number;
      newest: string | null;
    };

type Deps = {
  turns: {
    adoptFork: (
      threadId: string,
      thread: Thread,
      sourceId: string,
    ) => Promise<void>;
    liveTurnOf: (threadId: string) => LiveTurn | null;
    releaseThread: (threadId: string, ended: ThreadEnd) => void;
  };
  threads: Pick<
    ThreadValues,
    "adopt" | "threadOf" | "modeOf" | "effortOf" | "consumePick"
  >;
  sideChats: Pick<SideChats, "remember" | "showsCodex">;
  subagents: Pick<SubagentRequests, "withChildren" | "remember">;
  compatibility: ReturnType<typeof createCompatibility>;
  claudeModels: ModelCatalog["models"];
  effortRule: EffortRule;
  rememberCwd: (threadId: string, cwd: string) => void;
  log: (event: ResponseEvent) => void;
};

export const openingThread = (
  params: Record<string, unknown>,
  opened: Partial<Omit<ThreadOpen, "kind" | "params">> = {},
): ThreadOpen => ({
  kind: "threadOpen",
  createdModel: null,
  forkOf: null,
  history: null,
  sideChat: null,
  ...opened,
  params,
});

export const createServerResponses = ({
  turns,
  threads,
  sideChats,
  subagents,
  compatibility,
  claudeModels,
  effortRule,
  rememberCwd,
  log,
}: Deps) => {
  // A response that opens a Claude thread waits for its history, which holds back the server's later lines until it is read.
  const rewrite = (
    request: Pending,
    line: Buffer,
    message: Record<string, unknown>,
  ): Buffer | Promise<Buffer> => {
    if (request.kind === "initialize" || request.kind === "modelList") {
      if (compatibility.judge(request.kind, message)) return line;
    }
    if (!isObject(message.result)) return line;
    const result = message.result;
    switch (request.kind) {
      case "initialize":
        compatibility.noteInitialized(result);
        return line;
      case "modelList":
        return rewriteModelList(line, message, result);
      case "childList":
        return encode({
          ...message,
          result: subagents.withChildren(result, request.params),
        });
      case "threadRead":
        return rewriteThreadRead(line, message, result, request);
      case "threadOpen":
        return rewriteThreadOpen(line, message, result, request);
      case "threadEnd":
        turns.releaseThread(request.threadId, request.ended);
        return line;
    }
  };

  const rewriteModelList = (
    line: Buffer,
    message: Record<string, unknown>,
    result: Record<string, unknown>,
  ) => {
    if (compatibility.isIncompatible()) return line;
    const listed = withClaudeModels(result, claudeModels(), effortRule);
    for (const model of listed.collisions) {
      log({ event: "model_id_collision", model });
    }
    return encode({ ...message, result: listed.result });
  };

  const rewriteThreadRead = (
    line: Buffer,
    message: Record<string, unknown>,
    result: Record<string, unknown>,
    request: Extract<Pending, { kind: "threadRead" }>,
  ) => {
    if (request.history === null) {
      const live = turns.liveTurnOf(request.threadId) !== null;
      return live
        ? encode({ ...message, result: withLiveStatus(result, live) })
        : line;
    }
    return serveHistory(
      "thread/read",
      request.history,
      {
        threadId: request.threadId,
        label: threadIdOf(result),
        message,
        unreadable: () => line,
      },
      (shown) => ({
        excludeTurns: false,
        initialPage: false,
        picked: false,
        result: withTurns(result, shown),
      }),
    );
  };

  const rewriteThreadOpen = (
    line: Buffer,
    message: Record<string, unknown>,
    result: Record<string, unknown>,
    request: ThreadOpen,
  ) => {
    const thread = isObject(result.thread) ? result.thread : {};
    const threadId = thread.id;
    if (typeof threadId !== "string") return line;
    if (typeof result.cwd === "string") rememberCwd(threadId, result.cwd);
    if (request.sideChat !== null) {
      sideChats.remember(threadId, request.sideChat);
    }
    if (request.createdModel !== null && typeof result.cwd === "string") {
      threads.adopt(threadId, { model: request.createdModel, cwd: result.cwd });
    }
    const source =
      request.forkOf === null ? undefined : threads.threadOf(request.forkOf);
    // The app is shown the fork only once where its source stood has been read, so nothing the source says after the fork appears reaches it.
    if (request.forkOf !== null && source !== undefined) {
      return turns
        .adoptFork(threadId, source, request.forkOf)
        .then(() => openedResponse(line, message, request, threadId));
    }
    return openedResponse(line, message, request, threadId);
  };

  const openedResponse = (
    line: Buffer,
    message: Record<string, unknown>,
    request: ThreadOpen,
    threadId: string,
  ): Buffer | Promise<Buffer> => {
    const result = isObject(message.result) ? message.result : {};
    const thread = isObject(result.thread) ? result.thread : {};
    const model = threads.threadOf(threadId)?.model;
    if (model === undefined) return line;
    const reasoningEffort = shownEffort(threads.effortOf(threadId));
    const opened = {
      ...result,
      model,
      reasoningEffort,
      ...("model" in thread && {
        thread: {
          ...thread,
          model,
          ...("reasoningEffort" in thread && { reasoningEffort }),
        },
      }),
    };
    subagents.remember(opened);
    const unopened = () => encode({ ...message, result: opened });
    if (request.history === null) return unopened();
    const { params } = request;
    return serveHistory(
      "thread/resume",
      request.history,
      {
        threadId,
        label: threadId.slice(0, 8),
        message,
        unreadable: unopened,
      },
      (shown) => {
        // Taken only once the history goes out, since a resume the server fails would otherwise use up the pick.
        const picked = threads.consumePick(threadId);
        return {
          excludeTurns: params.excludeTurns === true,
          initialPage: isObject(params.initialTurnsPage),
          picked,
          result: withResumeHistory(opened, shown, params, picked),
        };
      },
    );
  };

  // Whether a turn runs is asked as the answer goes out, since it may end while the server answers.
  const serveHistory = (
    method: "thread/read" | "thread/resume",
    loading: ReturnType<History["load"]>,
    {
      threadId,
      label,
      message,
      unreadable,
    }: {
      threadId: string;
      label: string;
      message: Record<string, unknown>;
      unreadable: () => Buffer;
    },
    reply: (shown: readonly HistoryTurn[]) => {
      excludeTurns: boolean;
      initialPage: boolean;
      picked: boolean;
      result: Record<string, unknown>;
    },
  ) =>
    loading.then((loaded) => {
      if (loaded.isErr()) return unreadable();
      const shown = withLiveTurn(loaded.value, turns.liveTurnOf(threadId));
      const { result, ...flags } = reply(shown);
      log({
        event: "claude_history_served",
        method,
        thread: label,
        ...flags,
        turns: shown.length,
        newest: newestTurnOf(shown),
      });
      return encode({
        ...message,
        result: withLiveStatus(result, endsLive(shown)),
      });
    });

  // The server keeps its own model, effort and mode for a Claude thread, and the app shows what this notice reports after any settings change.
  const rewriteSettingsUpdated = (message: Record<string, unknown>) => {
    const params = isObject(message.params) ? message.params : {};
    const threadId =
      typeof params.threadId === "string" ? params.threadId : undefined;
    // The server already reports the Codex model a side chat was switched to before its first message.
    if (threadId !== undefined && sideChats.showsCodex(threadId)) return null;
    const model =
      threadId === undefined ? undefined : threads.threadOf(threadId)?.model;
    const selected =
      threadId === undefined ? undefined : threads.modeOf(threadId);
    const settings = params.threadSettings;
    if (threadId === undefined || model === undefined || !isObject(settings)) {
      return null;
    }
    const effort = shownEffort(threads.effortOf(threadId));
    const mode = settings.collaborationMode;
    return encode({
      ...message,
      params: {
        ...params,
        threadSettings: {
          ...settings,
          model,
          effort,
          ...(isObject(mode) &&
            isObject(mode.settings) && {
              collaborationMode: {
                ...mode,
                ...(selected !== undefined && { mode: selected }),
                settings: {
                  ...mode.settings,
                  model,
                  reasoning_effort: effort,
                },
              },
            }),
        },
      },
    });
  };

  return { rewrite, rewriteSettingsUpdated };
};

const newestTurnOf = (shown: readonly HistoryTurn[]) => {
  const id = shown.at(-1)?.turn.id;
  return id === undefined ? null : shortId(id);
};

// The id's head is enough to tell threads apart in a log without carrying the whole id.
const threadIdOf = (result: Record<string, unknown>) =>
  isObject(result.thread) && typeof result.thread.id === "string"
    ? result.thread.id.slice(0, 8)
    : "";
