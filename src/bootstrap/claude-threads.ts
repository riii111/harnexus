import { Result } from "better-result";
import {
  type CloudLogEvent,
  createCloudRuntime,
} from "../conversation/claude/cloud.ts";
import {
  type ClaudeLogEvent,
  createClaudeRuntime,
} from "../conversation/claude/runtime.ts";
import { createTurnController } from "../conversation/controller.ts";
import { createHistoryRequests } from "../conversation/history-request.ts";
import { createRevertRequests } from "../conversation/revert-request.ts";
import { createRouter, type RouteEvent } from "../conversation/route.ts";
import { createSideChats } from "../conversation/side-chat.ts";
import { createSubagentRequests } from "../conversation/subagent-requests.ts";
import { createSubagentRestore } from "../conversation/subagent-restore.ts";
import { createSubagents } from "../conversation/subagents.ts";
import { createThreadValues } from "../conversation/thread-values.ts";
import {
  type CloudCli,
  copyCloudSession,
  removeCloudCopy,
  sendToCloud,
} from "../infra/claude/cloud.ts";
import type { readClaudeSubagents } from "../infra/claude/session.ts";
import { createCallGateway } from "../infra/codex/call-gateway.ts";
import { createCodexLink } from "../infra/codex/codex-link.ts";
import { createDelegationWatch } from "../infra/codex/delegations.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import type { ThreadStore } from "../infra/thread-store.ts";
import { buildHistory, replayHistory } from "../presentation/history.ts";
import { prepareDirectory } from "../runtime/fs.boundary.ts";
import { resizeImage } from "../runtime/image.boundary.ts";

type Runtime = Parameters<typeof createClaudeRuntime>[0];

// The router, the turn controller and each session's thread tools share one store and one watch for created threads, so a child is traced to its parent whichever of them sees it first.
export const connectClaudeThreads = ({
  store,
  request,
  startSession,
  findSession,
  listConversations,
  lastRecordOf,
  readSession,
  readSubagents,
  effortRule,
  claudeModels,
  codexHome,
  cronRecord,
  permissionMode = "auto",
  cloud,
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
  readSubagents: (sessionId: string) => ReturnType<typeof readClaudeSubagents>;
  effortRule: Runtime["effortRule"];
  claudeModels: Parameters<typeof createRouter>[0]["claudeModels"];
  permissionMode?: Runtime["permissionMode"];
  codexHome: string;
  cronRecord: Parameters<typeof createCodexLink>[0]["cronRecord"];
  // Where Cloud sessions are reached and copied; without it a thread cannot link one.
  cloud?: {
    cli: CloudCli;
    copyDir: string;
    discardCopy?: (copySessionId: string) => Promise<void>;
  };
  send: (message: object) => void;
  log: (event: ClaudeLogEvent | RouteEvent | CloudLogEvent) => void;
}) => {
  const delegations = createDelegationWatch();
  const openLink = (callerThreadId: string) =>
    createCodexLink({
      callerThreadId,
      store,
      request,
      delegations,
      codexHome,
      cronRecord,
    });
  const threads = createThreadValues(store, log);
  const subagents = createSubagents({ send });
  const subagentRestore = createSubagentRestore({
    subagents,
    readSubagents,
    log,
  });
  const readHistory = async (
    threadId: string,
    sessionId: string,
    cwd: string,
  ) => {
    const read = await readSession(sessionId);
    if (read.isErr()) {
      log({ event: "claude_history_unreadable", error: read.error._tag });
      return [];
    }
    // A picked conversation's agents are read back first, so its replay names them as a later read does.
    await subagentRestore.restore(threadId, sessionId, cwd, read.value);
    return replayHistory(
      buildHistory(
        read.value,
        { threadId, cwd },
        subagents.agentRefOf(threadId),
      ),
      threadId,
      Date.now(),
    );
  };
  const claude = createClaudeRuntime({
    threads,
    permissionMode,
    startSession,
    findSession,
    listConversations,
    lastRecordOf,
    readHistory,
    renameThread: (threadId, name) =>
      request(
        "thread/name/set",
        { threadId, name },
        { timeoutMs: RENAME_TIMEOUT_MS },
      ),
    openLink: (callerThreadId) => openLink(callerThreadId),
    send,
    log,
    effortRule,
    subagents,
    resizeImage,
  });
  const runtime = createCloudRuntime(claude, {
    threads,
    sendToCloud: (cloudSessionId, text, cwd) =>
      cloud === undefined
        ? Promise.resolve({ kind: "rejected", message: CLOUD_OFF })
        : sendToCloud(cloud.cli, cloudSessionId, text, cwd),
    copy: (cloudSessionId) =>
      cloud === undefined
        ? Promise.resolve(Result.err({ _tag: "CloudOff", message: CLOUD_OFF }))
        : copyInto(cloud.cli, cloudSessionId, cloud.copyDir),
    readCopy: (copySessionId) => readSession(copySessionId),
    discardCopy: cloud?.discardCopy ?? ((copy) => removeCloudCopy(copy)),
    replayHistory: readHistory,
    send,
    log,
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
    subagentHistory: subagents.historyOf,
    subagents: {
      restore: subagentRestore.restore,
      agentRefOf: subagents.agentRefOf,
    },
  });
  const subagentRequests = createSubagentRequests({
    subagents,
    threads: turns,
    call: (method, params) =>
      request(method, params, { timeoutMs: SUBAGENT_PARENT_TIMEOUT_MS }),
    history: history.load,
    send,
  });
  const sideChats = createSideChats({
    sessionIdOf: turns.sessionIdOf,
    rewindOf: turns.rewindOf,
    lastRecordOf,
    readSession,
    listTurns: (threadId, page) =>
      request(
        "thread/turns/list",
        { threadId, ...page, itemsView: "full" },
        { timeoutMs: READ_TIMEOUT_MS },
      ),
    inject: (threadId, items) =>
      request(
        "thread/inject_items",
        { threadId, items },
        { timeoutMs: INJECT_TIMEOUT_MS },
      ),
    isClaudeThread: turns.isClaudeThread,
    claudeBegun: turns.claudeBegun,
    dropFork: turns.dropFork,
    noteSideChat: turns.noteSideChat,
  });
  const router = createRouter({
    turns,
    log,
    delegations,
    history,
    claudeModels,
    subagents: subagentRequests,
    revert: createRevertRequests({
      store,
      threads,
      turns,
      runtime,
      readSession,
      request,
      send,
    }),
    sideChats,
  });
  const callGateway = createCallGateway({
    isClaudeThread: (threadId) => store.get(threadId) !== undefined,
    openLink,
    request,
    delegations,
  });
  return { router, closeAll: turns.closeAll, callGateway };
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

// The folder is made on first use, so a bridge that never links a Cloud session leaves nothing behind.
const copyInto = async (
  cli: CloudCli,
  cloudSessionId: string,
  copyDir: string,
) => {
  const ready = await prepareDirectory(copyDir);
  if (ready.isErr()) {
    return Result.err({ _tag: ready.error._tag, message: ready.error.message });
  }
  return copyCloudSession(cli, cloudSessionId, copyDir);
};

const CLOUD_OFF = "Cloud sessions are not set up for this bridge";

const INJECT_TIMEOUT_MS = 30_000;

const READ_TIMEOUT_MS = 30_000;

const RENAME_TIMEOUT_MS = 10_000;

const SUBAGENT_PARENT_TIMEOUT_MS = 10_000;
