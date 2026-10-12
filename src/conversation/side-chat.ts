import { Result } from "better-result";
import { isClaudeModel } from "../infra/claude/models.ts";
import type { readClaudeSession } from "../infra/claude/session.ts";
import type { readLastRecordUuid } from "../infra/claude/transcripts.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import { buildHistory } from "../presentation/history.ts";
import { sideChatBrief } from "../presentation/side-chat-brief.ts";
import { recordUntil } from "./history-request.ts";
import type { Refusal, Thread } from "./thread-request.ts";

// Where the main conversation stood when the side chat opened; null when it held no conversation yet.
export type ForkPoint = {
  sessionId: string;
  at: string;
  model: string;
  cwd: string;
} | null;

// choice is the Codex model the side chat was opened on or switched to before its first message; stopped marks a hand-over whose outcome is unknown.
type SideChat = { point: ForkPoint; choice: string | null; stopped: boolean };

type Deps = {
  sessionIdOf: (threadId: string) => string | null;
  lastRecordOf: (sessionId: string) => ReturnType<typeof readLastRecordUuid>;
  readSession: (sessionId: string) => ReturnType<typeof readClaudeSession>;
  inject: (threadId: string, items: object[]) => ReturnType<ServerRequest>;
  claudeBegun: (threadId: string) => boolean;
  dropFork: (threadId: string) => void;
};

// A side chat of a Claude thread may move to Codex before its first message; the server's copy of the thread holds none of the Claude conversation, so the conversation up to the fork is handed to the Codex thread once, and only then does the side chat stop being a Claude thread.
// Nothing here is saved: a side chat is ephemeral, and the server, which the bridge runs, drops it on a restart.
export const createSideChats = ({
  sessionIdOf,
  lastRecordOf,
  readSession,
  inject,
  claudeBegun,
  dropFork,
}: Deps) => {
  const sideChats = new Map<string, SideChat>();

  const pointOf = async (sourceId: string, source: Thread) => {
    const sessionId = sessionIdOf(sourceId);
    if (sessionId === null) return Result.ok<ForkPoint>(null);
    const last = await lastRecordOf(sessionId);
    return last.map(
      (at): ForkPoint =>
        at === null
          ? null
          : { sessionId, at, model: source.model, cwd: source.cwd },
    );
  };

  const remember = (
    threadId: string,
    point: ForkPoint,
    model: string | undefined,
  ) => {
    sideChats.set(threadId, {
      point,
      choice: isCodexModel(model) ? model : null,
      stopped: false,
    });
  };

  // Null leaves the turn to the usual routing; a Claude conversation the side chat already began keeps it on Claude.
  const beforeTurn = (
    threadId: string,
    requested: string | undefined,
  ): Promise<Refusal | null> | null => {
    const sideChat = current(threadId);
    if (sideChat === undefined) return null;
    if (sideChat.stopped) return Promise.resolve("side_chat_stopped");
    const model = requested ?? sideChat.choice ?? undefined;
    return isCodexModel(model) ? handOver(threadId, sideChat) : null;
  };

  // A Codex model picked before the first message only marks the choice, so picking Claude again leaves the side chat as it was.
  const beforeSettings = (
    threadId: string,
    requested: string | undefined,
  ): Refusal | "pass" | null => {
    const sideChat = current(threadId);
    if (sideChat === undefined) return null;
    if (sideChat.stopped) return "side_chat_stopped";
    if (requested === undefined) return null;
    if (!isCodexModel(requested)) {
      sideChat.choice = null;
      return null;
    }
    sideChat.choice = requested;
    return "pass";
  };

  const isStopped = (threadId: string) =>
    sideChats.get(threadId)?.stopped === true;

  const showsCodex = (threadId: string) => current(threadId)?.choice != null;

  const current = (threadId: string) => {
    const sideChat = sideChats.get(threadId);
    if (sideChat === undefined || sideChat.stopped) return sideChat;
    if (!claudeBegun(threadId)) return sideChat;
    sideChats.delete(threadId);
    return undefined;
  };

  // Everything stays as it was until the conversation is handed over, so a failure that wrote nothing can be sent again; one whose outcome is unknown may have written it, so the side chat takes no more messages rather than risk a second copy or none.
  const handOver = async (threadId: string, sideChat: SideChat) => {
    const brief = await briefOf(threadId, sideChat.point);
    if (brief.isErr()) return "side_chat_not_briefed" as const;
    if (brief.value !== null) {
      const injected = await inject(threadId, [brief.value]);
      if (injected.isErr()) {
        if (injected.error._tag !== "ServerRequestUnanswered") {
          return "side_chat_not_briefed" as const;
        }
        sideChat.stopped = true;
        return "side_chat_stopped" as const;
      }
    }
    sideChats.delete(threadId);
    dropFork(threadId);
    return null;
  };

  const briefOf = async (threadId: string, point: ForkPoint) => {
    if (point === null) return Result.ok(null);
    const read = await readSession(point.sessionId);
    return read
      .andThen((messages) => recordUntil(messages, point.at))
      .map((messages) =>
        sideChatBrief(
          buildHistory(messages, { threadId, cwd: point.cwd }),
          point.model,
        ),
      );
  };

  return {
    pointOf,
    remember,
    beforeTurn,
    beforeSettings,
    isStopped,
    showsCodex,
  };
};

const isCodexModel = (model: string | undefined): model is string =>
  model !== undefined && !isClaudeModel(model);
