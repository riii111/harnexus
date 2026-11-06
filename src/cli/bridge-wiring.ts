import { Result } from "better-result";

import { openCloudChild } from "../features/conversation/claude/cloud/child-chats.ts";
import {
  type CloudLogEvent,
  createCloudRuntime,
} from "../features/conversation/claude/cloud/runtime.ts";
import {
  type ClaudeLogEvent,
  createClaudeRuntime,
} from "../features/conversation/claude/runtime.ts";
import {
  createExternalConversations,
  type ExternalLogEvent,
  type ExternalStateStore,
  type SpawnAdapter,
} from "../features/conversation/external/conversations.ts";
import { externalHistoryRecords } from "../features/conversation/external/history.ts";
import { createExternalRuntime } from "../features/conversation/external/runtime.ts";
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
import type { CloudLinkReservations } from "../infra/cloud-links.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import { createThreadRequests } from "../infra/codex/thread-requests.ts";
import type { ThreadStore } from "../infra/thread-store.ts";
import type { AdapterSettings } from "../lib/connection-settings.boundary.ts";
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
  cloudLinks,
  cloudSkills = [],
  external,
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
  };
  // The chats cloud_open opened, by Cloud session.
  cloudLinks: CloudLinkReservations;
  // Skills the user set to mean /cloud when picked in an empty chat.
  cloudSkills?: readonly string[];
  // The chats bound to outside conversations and the adapter the user registered, if any, started once the threads are connected.
  external?: {
    adapter: { settings: AdapterSettings; spawn: SpawnAdapter } | null;
    bridgeId: string;
    store: ExternalStateStore;
  };
  send: (message: object) => void;
  log: (
    event: ClaudeLogEvent | RouteEvent | CloudLogEvent | ExternalLogEvent,
  ) => void;
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
    cloudLinks,
    ...(cloud !== undefined && {
      startCloud: (prompt: string, cwd: string) =>
        startCloudSession(cloud.cli.file, prompt, {
          cwd,
          env: cloud.cli.env,
        }),
    }),
  });
  const conversations =
    external === undefined
      ? null
      : createExternalConversations({
          adapter:
            external.adapter === null
              ? null
              : {
                  id: external.adapter.settings.id,
                  mode: external.adapter.settings.mode,
                  spawn: external.adapter.spawn,
                },
          bridgeId: external.bridgeId,
          store: external.store,
          call: callGateway.handle,
          isCaller: threads.isSavedClaudeThread,
          holdsConversation: (threadId) =>
            threads.sessionIdOf(threadId) !== null ||
            threads.cloudOf(threadId) !== null,
          cloudOwner: (sessionId) => store.cloudOwner(sessionId),
          sendToSession: async (
            sessionId,
            text,
          ): Promise<{
            outcome: "done" | "rejected" | "unknown";
            message?: string;
          }> => {
            const owner = store.cloudOwner(sessionId);
            const record = owner === undefined ? undefined : store.get(owner);
            if (cloud === undefined || record === undefined)
              return { outcome: "rejected", message: CLOUD_OFF };
            const sent: Awaited<ReturnType<typeof runtime.sendToSession>> =
              await runtime.sendToSession(sessionId, text, record.worktree);
            if (sent.isOk()) return { outcome: "done" };
            return {
              outcome:
                sent.error._tag === "CloudSendUnknown" ? "unknown" : "rejected",
              message: sent.error.message,
            };
          },
          log,
        });
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
    ...(conversations !== null && { observe: conversations.observe }),
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
    runtime: createExternalRuntime(runtime, conversations),
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
    ...(conversations !== null && {
      keptRecords: async (threadId: string) => {
        if (!conversations.isBound(threadId)) return null;
        const entries = await conversations.history(threadId);
        return entries === null
          ? null
          : externalHistoryRecords(threadId, entries);
      },
    }),
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
  conversations?.start();
  return {
    router,
    closeAll: turns.closeAll,
    callGateway,
  } as const;
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
