import {
  type ClaudeLogEvent,
  createClaudeRuntime,
} from "../conversation/claude/runtime.ts";
import { createTurnController } from "../conversation/controller.ts";
import { createHistoryRequests } from "../conversation/history-request.ts";
import { createRouter, type RouteEvent } from "../conversation/route.ts";
import { createThreadValues } from "../conversation/thread-values.ts";
import { createCodexLink } from "../infra/codex/codex-link.ts";
import { createDelegationWatch } from "../infra/codex/delegations.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import type { ThreadStore } from "../infra/thread-store.ts";
import { buildHistory, replayHistory } from "../presentation/history.ts";

type Runtime = Parameters<typeof createClaudeRuntime>[0];

// The router, the turn controller and each session's thread tools share one store and one watch for created threads, so a reviewer is traced to its worker whichever of them sees it first.
export const connectClaudeThreads = ({
  store,
  request,
  startSession,
  findSession,
  listConversations,
  lastRecordOf,
  readSession,
  effortRule,
  claudeModels,
  unverifiedCodex,
  send,
  log,
}: {
  store: ThreadStore;
  request: ServerRequest;
  startSession: Runtime["startSession"];
  findSession: Runtime["findSession"];
  listConversations: Runtime["listConversations"];
  lastRecordOf: Runtime["lastRecordOf"];
  readSession: Parameters<typeof createHistoryRequests>[0]["readSession"];
  effortRule: Runtime["effortRule"];
  claudeModels: Parameters<typeof createRouter>[4];
  unverifiedCodex: Parameters<typeof createRouter>[5];
  send: (message: object) => void;
  log: (event: ClaudeLogEvent | RouteEvent) => void;
}) => {
  const delegations = createDelegationWatch(store.claimReviewer);
  const threads = createThreadValues(store, log);
  const runtime = createClaudeRuntime({
    threads,
    startSession,
    findSession,
    listConversations,
    lastRecordOf,
    readHistory: async (threadId, sessionId, cwd) => {
      const read = await readSession(sessionId);
      return read.isOk()
        ? replayHistory(
            buildHistory(read.value, { threadId, cwd }),
            threadId,
            Date.now(),
          )
        : [];
    },
    openLink: (callerThreadId) =>
      createCodexLink({ callerThreadId, store, request, delegations }),
    send,
    log,
    effortRule,
  });
  const turns = createTurnController({
    store,
    threads,
    runtime,
    materializeThread: (threadId) =>
      request(
        "thread/inject_items",
        { threadId, items: [THREAD_NOTE] },
        { timeoutMs: INJECT_TIMEOUT_MS },
      ),
    send,
    log,
    effortRule,
  });
  const history = createHistoryRequests({
    threads: turns,
    readSession,
    send,
    log,
  });
  const router = createRouter(
    turns,
    log,
    delegations.observe,
    history,
    claudeModels,
    unverifiedCodex,
  );
  return { router, closeAll: turns.closeAll };
};

// The server writes a thread to disk only once it holds some history, and Claude turns never reach it, so without this item the app cannot reopen a Claude thread after a restart; the note carries no conversation text.
const THREAD_NOTE = {
  type: "message",
  role: "developer",
  content: [
    {
      type: "input_text",
      text: "This thread runs on Claude through Harnexus; its conversation is kept in Claude's session record.",
    },
  ],
};

const INJECT_TIMEOUT_MS = 30_000;
