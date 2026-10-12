import { Result, TaggedError } from "better-result";
import { isClaudeModel } from "../infra/claude/models.ts";
import type { readClaudeSession } from "../infra/claude/session.ts";
import type { readLastRecordUuid } from "../infra/claude/transcripts.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import type { RewindPoint } from "../infra/thread-store.ts";
import { buildHistory } from "../presentation/history.ts";
import {
  listedTurns,
  sideChatBrief,
  sideChatReference,
} from "../presentation/side-chat-brief.ts";
import { recordUntil } from "./history-request.ts";
import type { Refusal, Thread } from "./thread-request.ts";
import type { SideChatContext } from "./thread-values.ts";

// Where the main conversation stood when the side chat opened; null when it held no conversation yet.
export type ForkPoint = {
  sessionId: string;
  at: string;
  model: string;
  cwd: string;
} | null;

// A Claude main conversation is read only when the side chat moves to Codex, from the point fixed at the fork; a Codex one is read while the fork is asked for, since the server keeps no turns of an ephemeral fork, and only the reference made from it is kept. An unread one keeps the side chat on its main thread's agent.
export type Parent =
  | { agent: "Claude"; point: ForkPoint }
  | { agent: "Codex"; reference: string | null }
  | { agent: "Claude" | "Codex"; unread: true };

// What a side chat was opened with: instructions are what the app gave it, model the one it was opened on, if any.
export type Opened = {
  parent: Parent;
  instructions: string | null;
  model: string | undefined;
};

// choice is the model picked before the first message; ranOnCodex marks a side chat whose model is fixed once a message went to Codex, as a Claude turn accepted or run does for Claude; stopped marks a hand-over whose outcome is unknown.
type SideChat = {
  parent: Parent;
  choice: string | undefined;
  ranOnCodex: boolean;
  stopped: boolean;
};

class MainThreadUnreadable extends TaggedError("MainThreadUnreadable")<{
  message: string;
}> {}

type Deps = {
  sessionIdOf: (threadId: string) => string | null;
  rewindOf: (threadId: string) => RewindPoint | undefined;
  lastRecordOf: (sessionId: string) => ReturnType<typeof readLastRecordUuid>;
  readSession: (sessionId: string) => ReturnType<typeof readClaudeSession>;
  listTurns: (
    threadId: string,
    page: { limit: number; sortDirection: "asc" | "desc" },
  ) => ReturnType<ServerRequest>;
  inject: (threadId: string, items: object[]) => ReturnType<ServerRequest>;
  isClaudeThread: (threadId: string) => boolean;
  claudeBegun: (threadId: string) => boolean;
  dropFork: (threadId: string) => void;
  noteSideChat: (threadId: string, context: SideChatContext) => void;
};

// A side chat picks its model before its first message, whichever agent runs the main thread, and keeps it after; the agent it moves to is handed the main conversation up to the fork, and the app's instructions for the side chat reach Claude too.
// Nothing here is saved: a side chat is ephemeral, and the server, which the bridge runs, drops it on a restart.
export const createSideChats = ({
  sessionIdOf,
  rewindOf,
  lastRecordOf,
  readSession,
  listTurns,
  inject,
  isClaudeThread,
  claudeBegun,
  dropFork,
  noteSideChat,
}: Deps) => {
  const sideChats = new Map<string, SideChat>();

  // A rewound conversation stands where it was rewound to until its next turn, though its record still holds the turns after.
  const pointOf = async (sourceId: string, source: Thread) => {
    const rewind = rewindOf(sourceId);
    if (rewind !== undefined) {
      return Result.ok<ForkPoint>(
        rewind.at === null
          ? null
          : {
              sessionId: rewind.sessionId,
              at: rewind.at,
              model: source.model,
              cwd: source.cwd,
            },
      );
    }
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

  // Read as the app reads a main thread for a cloud side chat: its newest turns, and its oldest one when there are more, with no further pages. The newest page sets what is handed over, so a turn added after it is left out; an oldest page with no turn though more were said to exist fails the read rather than hand over a mix.
  const referenceOf = async (parentId: string) => {
    const newest = await readPage(parentId, NEWEST);
    if (newest.isErr()) return Result.err(newest.error);
    const recent = [...newest.value.turns].reverse();
    if (!newest.value.more) {
      return Result.ok(
        sideChatReference(recent, { agent: "Codex", model: null }),
      );
    }
    const oldest = await readPage(parentId, OLDEST);
    if (oldest.isErr()) return Result.err(oldest.error);
    const first = oldest.value.turns[0];
    if (first === undefined) {
      return Result.err(
        new MainThreadUnreadable({
          message: "the pages of the main thread disagree on where it starts",
        }),
      );
    }
    // A turn both pages hold is taken from the newest page, which then reaches the oldest turn and leaves nothing unread.
    if (recent.some(({ id }) => id === first.id)) {
      return Result.ok(
        sideChatReference(recent, { agent: "Codex", model: null }),
      );
    }
    return Result.ok(
      sideChatReference([first, ...recent], {
        agent: "Codex",
        model: null,
        unreadAfterFirst: true,
      }),
    );
  };

  const readPage = async (
    threadId: string,
    page: { limit: number; sortDirection: "asc" | "desc" },
  ) => {
    const listed = await listTurns(threadId, page);
    return listed.andThen((result) => {
      const turns = listedTurns(result);
      return turns === null
        ? Result.err(
            new MainThreadUnreadable({
              message: "the server's answer is not a page of turns",
            }),
          )
        : Result.ok(turns);
    });
  };

  const remember = (
    threadId: string,
    { parent, instructions, model }: Opened,
  ) => {
    sideChats.set(threadId, {
      parent,
      choice: model,
      ranOnCodex: false,
      stopped: false,
    });
    noteSideChat(threadId, {
      instructions,
      reference: "reference" in parent ? parent.reference : null,
    });
  };

  // Null leaves the turn to the usual routing, which runs it on the model it names.
  const beforeTurn = (
    threadId: string,
    requested: string | undefined,
  ): Promise<Refusal | null> | null => {
    const sideChat = current(threadId);
    if (sideChat === undefined) return null;
    if (sideChat.stopped) return Promise.resolve("side_chat_stopped");
    const claude = runsOnClaude(threadId, requested ?? sideChat.choice);
    if (sideChat.ranOnCodex) {
      return claude ? Promise.resolve("side_chat_model_fixed") : null;
    }
    const { parent } = sideChat;
    if (movesAway(parent, claude) && "unread" in parent) {
      return Promise.resolve("side_chat_main_unread");
    }
    if (claude) return null;
    if ("point" in parent) return handOver(threadId, sideChat, parent.point);
    sideChat.ranOnCodex = true;
    return null;
  };

  // A model picked before the first message only marks the choice, so picking the other agent again leaves the side chat as it was.
  const beforeSettings = (
    threadId: string,
    requested: string | undefined,
  ): Refusal | "pass" | null => {
    const sideChat = current(threadId);
    if (sideChat === undefined) return null;
    if (sideChat.stopped) return "side_chat_stopped";
    if (requested === undefined) return null;
    const claude = isClaudeModel(requested);
    if (sideChat.ranOnCodex) return claude ? "side_chat_model_fixed" : null;
    if (movesAway(sideChat.parent, claude) && "unread" in sideChat.parent) {
      return "side_chat_main_unread";
    }
    sideChat.choice = requested;
    if (claude || !isClaudeThread(threadId)) return null;
    // A Codex main thread's side chat taken up by Claude before its first message goes back to the server's thread.
    if (sideChat.parent.agent === "Codex") dropFork(threadId);
    return "pass";
  };

  const isStopped = (threadId: string) =>
    sideChats.get(threadId)?.stopped === true;

  // The server reports the Codex model a Claude side chat was switched to before its first message.
  const showsCodex = (threadId: string) => {
    const choice = current(threadId)?.choice;
    return choice !== undefined && !isClaudeModel(choice);
  };

  const current = (threadId: string) => {
    const sideChat = sideChats.get(threadId);
    if (sideChat === undefined || sideChat.stopped) return sideChat;
    if (!claudeBegun(threadId)) return sideChat;
    sideChats.delete(threadId);
    return undefined;
  };

  // A turn naming no model runs where the side chat runs now.
  const runsOnClaude = (threadId: string, model: string | undefined) =>
    model === undefined ? isClaudeThread(threadId) : isClaudeModel(model);

  // Everything stays as it was until the conversation is handed over, so a failure that wrote nothing can be sent again; one whose outcome is unknown may have written it, so the side chat takes no more messages rather than risk a second copy or none.
  const handOver = async (
    threadId: string,
    sideChat: SideChat,
    point: ForkPoint,
  ) => {
    const brief = await briefOf(threadId, point);
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
    sideChat.ranOnCodex = true;
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
    referenceOf,
    remember,
    beforeTurn,
    beforeSettings,
    isStopped,
    showsCodex,
  };
};

const movesAway = (parent: Parent, claude: boolean) =>
  claude !== (parent.agent === "Claude");

// The app reads this many of a main thread's newest turns for a cloud side chat.
const NEWEST = { limit: 50, sortDirection: "desc" } as const;

const OLDEST = { limit: 1, sortDirection: "asc" } as const;
