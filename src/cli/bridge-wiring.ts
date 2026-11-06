import { Result } from "better-result";

import { openCloudChild } from "../features/conversation/claude/cloud/child-chats.ts";
import { createCloudReviews } from "../features/conversation/claude/cloud/review-chats.ts";
import {
  type CloudLogEvent,
  createCloudRuntime,
} from "../features/conversation/claude/cloud/runtime.ts";
import {
  type ClaudeLogEvent,
  createClaudeRuntime,
} from "../features/conversation/claude/runtime.ts";
import {
  buildHistory,
  replayHistory,
} from "../features/conversation/history/history.view.ts";
import { createHistoryRequests } from "../features/conversation/history/request.ts";
import { createRevertRequests } from "../features/conversation/history/revert-request.ts";
import {
  createRouter,
  type RouteEvent,
} from "../features/conversation/route.ts";
import { createSideChats } from "../features/conversation/side-chat/side-chat.ts";
import { createSubagentRequests } from "../features/conversation/subagents/requests.ts";
import { createSubagentRestore } from "../features/conversation/subagents/restore.ts";
import { createSubagents } from "../features/conversation/subagents/subagents.ts";
import { createThreadValues } from "../features/conversation/thread-values.ts";
import { createTurnController } from "../features/conversation/turn/controller.ts";
import { createCallGateway } from "../features/link/call-gateway.ts";
import { createCodexLink } from "../features/link/codex-link.ts";
import { createDelegationWatch } from "../features/link/delegations.ts";
import type { CloudCheckouts } from "../infra/claude/cloud-checkouts.ts";
import { startCloudSession } from "../infra/claude/cloud-new.boundary.ts";
import {
  type CloudCli,
  CloudOff,
  CloudSendRejected,
  copyCloudSession,
  removeCloudCopy,
  sendToCloud,
} from "../infra/claude/cloud.ts";
import type { readClaudeSubagents } from "../infra/claude/session.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import { createThreadRequests } from "../infra/codex/thread-requests.ts";
import type { ThreadStore } from "../infra/thread-store.ts";
import { resizeImage } from "../lib/image.boundary.ts";

type Runtime = Parameters<typeof createClaudeRuntime>[0];

// Connects the router, the turn controller and each session's thread tools for Claude threads.
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
  cloudSkills = [],
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
    checkouts: CloudCheckouts;
    // Where the reviews a Cloud session read are kept for their chats.
    reviewDir: string;
  };
  // Skills the user set to mean /cloud when picked in an empty chat.
  cloudSkills?: readonly string[];
  send: (message: object) => void;
  log: (event: ClaudeLogEvent | RouteEvent | CloudLogEvent) => void;
}) => {
  // One store and one watch for created threads are shared, so a child is traced to its parent whichever part sees it first.
  const delegations = createDelegationWatch();
  // The link of each thread's running session, so its socket calls share the stop, order and unknown-outcome state of the turn's own tool calls.
  const sessionLinks = new Map<string, ReturnType<typeof createCodexLink>>();
  const openLink = (callerThreadId: string) =>
    createCodexLink({
      callerThreadId,
      store,
      request,
      delegations,
      codexHome,
      cronRecord,
    });
  const threads = createThreadValues(store, log, effortRule);
  const appThreads = createThreadRequests(request);
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

  const renameThread = appThreads.rename;
  const claude = createClaudeRuntime({
    threads,
    permissionMode,
    startSession,
    findSession,
    listConversations,
    lastRecordOf,
    readHistory,
    renameThread,
    openLink: (callerThreadId) => {
      const link = openLink(callerThreadId);
      sessionLinks.set(callerThreadId, link);
      return link;
    },
    send,
    log,
    effortRule,
    subagents,
    resizeImage,
  });
  const callGateway = createCallGateway({
    isClaudeThread: threads.isSavedClaudeThread,
    openLink,
    sessionLink: (threadId) => sessionLinks.get(threadId),
    request,
    delegations,
    cloudOwner: (cloudSessionId) => store.cloudOwner(cloudSessionId),
    ...(cloud !== undefined && {
      startCloud: (prompt: string, cwd: string) =>
        startCloudSession(cloud.cli.file, prompt, {
          cwd,
          env: cloud.cli.env,
        }),
    }),
  });
  const reviews =
    cloud === undefined
      ? undefined
      : createCloudReviews(cloud.reviewDir, (call) => callGateway.handle(call));
  const runtime = createCloudRuntime(claude, {
    threads,
    sendToCloud: (cloudSessionId, text, cwd) =>
      cloud === undefined
        ? Promise.resolve(
            Result.err(new CloudSendRejected({ message: CLOUD_OFF })),
          )
        : sendToCloud(cloud.cli, cloudSessionId, text, cwd),
    copy: (cloudSessionId) =>
      cloud === undefined
        ? Promise.resolve(Result.err(new CloudOff({ message: CLOUD_OFF })))
        : // The folder is made on first use, so a bridge that never links a Cloud session leaves nothing behind.
          copyCloudSession(cloud.cli, cloudSessionId, {
            cwd: cloud.copyDir,
            checkouts: cloud.checkouts,
          }),
    readCopy: (copySessionId) => readSession(copySessionId),
    discardCopy: (copySessionId) => removeCloudCopy(copySessionId),
    replayHistory: readHistory,
    send,
    log,
    renameThread,
    cloudSkills,
    ...(reviews === undefined
      ? {}
      : {
          openReview: (parentThreadId, review) => {
            const parent = store.get(parentThreadId);
            return parent === undefined
              ? Promise.resolve("no_parent")
              : reviews.openReview(
                  parentThreadId,
                  parent.worktree,
                  review,
                  parent.cloud?.sessionId ?? null,
                );
          },
          reviewOf: reviews.reviewOf,
          reviewChatOf: reviews.chatOf,
          noteReviewAsk: reviews.noteAsk,
        }),
    ...(cloud === undefined
      ? {}
      : {
          startCloud: (request, cwd) =>
            startCloudSession(cloud.cli.file, request, {
              cwd,
              env: cloud.cli.env,
            }),
        }),
    openChild: (parentThreadId, child) => {
      const parent = store.get(parentThreadId);
      return parent === undefined
        ? Promise.resolve("no_parent")
        : openCloudChild(
            (call) => callGateway.handle(call),
            parentThreadId,
            parent.worktree,
            child,
          );
    },
  });
  const turns = createTurnController({
    store,
    threads,
    runtime,
    materializeThread: (threadId) => appThreads.inject(threadId, [THREAD_NOTE]),
    send,
    log,
  });
  const history = createHistoryRequests({
    threads,
    liveTurnOf: turns.liveTurnOf,
    recordOf: runtime.recordOf,
    readSession,
    send,
    log,
    subagentHistory: subagents.historyOf,
    ...(reviews === undefined ? {} : { keptRecords: reviews.recordsOf }),
    subagents: {
      restore: subagentRestore.restore,
      agentRefOf: subagents.agentRefOf,
    },
  });
  const subagentRequests = createSubagentRequests({
    subagents,
    threads,
    call: appThreads.subagentParent,
    history: history.load,
    send,
  });
  const sideChats = createSideChats({
    sessionIdOf: threads.sessionIdOf,
    rewindOf: threads.rewindOf,
    lastRecordOf,
    readSession,
    listTurns: appThreads.listTurns,
    inject: appThreads.inject,
    isClaudeThread: threads.isClaudeThread,
    claudeBegun: turns.claudeBegun,
    dropFork: turns.dropFork,
    noteSideChat: threads.noteSideChat,
  });
  const router = createRouter({
    turns,
    threads,
    log,
    delegations,
    history,
    claudeModels,
    effortRule,
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

const CLOUD_OFF = "Cloud sessions are not set up for this bridge";
