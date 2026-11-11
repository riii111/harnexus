import { Result, TaggedError } from "better-result";

import { isClaudeModel } from "../../../infra/claude/models.ts";
import type { readClaudeSession } from "../../../infra/claude/session.ts";
import type { readLastRecordUuid } from "../../../infra/claude/transcripts.ts";
import type { ServerRequest } from "../../../infra/codex/server-requests.ts";
import type {
  NotSavedReason,
  SavedSideChat,
  SideChatStore,
} from "../../../infra/side-chat-store.ts";
import type { RewindPoint } from "../../../infra/thread-store.ts";
import { buildHistory } from "../history/history.view.ts";
import { recordUntil } from "../history/request.ts";
import type { Refusal, Thread } from "../thread-request.ts";
import type { SideChatContext } from "../thread-values.ts";
import type { ThreadEnd } from "../turn/turn-runtime.ts";
import { listedTurns, sideChatBrief, sideChatReference } from "./brief.view.ts";

// Where the main conversation stood when the side chat opened; null when it held no conversation yet.
export type ForkPoint = {
  sessionId: string;
  at: string;
  model: string;
  cwd: string;
} | null;

// A Claude main conversation is read only when the side chat moves to Codex, from the point fixed at the fork; a Codex one is read while the fork is asked for, since the server keeps no turns of an ephemeral fork, and only the reference made from it is kept. An unread one keeps the side chat on its main thread's agent.
type Parent =
  | { agent: "Claude"; point: ForkPoint }
  | { agent: "Codex"; reference: string | null }
  | { agent: "Claude" | "Codex"; unread: true };

// What a side chat was opened with: instructions are what the app gave it, model the one it was opened on, if any. kept is set on a side chat the server keeps through a restart, which is saved too; claudeThread is the Claude thread it runs as until a message goes to Codex, null when it opened on Codex.
export type Opened = {
  parent: Parent;
  instructions: string | null;
  model: string | undefined;
  kept: { claudeThread: Thread | null } | null;
};

// choice is the model picked before the first message; ranOnCodex marks a side chat whose model is fixed once a message went to Codex, as a Claude turn accepted or run does for Claude; stopped marks a hand-over whose outcome is unknown; saved is what a restart restores, for a side chat the server keeps.
type SideChat = {
  parent: Parent;
  choice: string | undefined;
  ranOnCodex: boolean;
  stopped: boolean;
  saved: SavedSideChat | null;
};

export type SideChatEvent = {
  event: "side_chat_not_saved";
  error: NotSavedReason;
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
  restoreFork: (
    threadId: string,
    thread: Thread,
    source: { sessionId: string; at: string } | null,
  ) => Promise<void>;
  saved: SideChatStore;
  log: (event: SideChatEvent) => void;
};

// Each side chat's model until its first message, and the main conversation up to the fork handed to the agent it moves to.
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
  restoreFork,
  saved,
  log,
}: Deps) => {
  // Only a side chat the server keeps through a restart is saved, since the server drops an ephemeral one.
  const sideChats = new Map<string, SideChat>();

  const pointOf = async (sourceId: string, source: Thread) => {
    const rewind = rewindOf(sourceId);
    // A rewound conversation stands where it was rewound to until its next turn, though its record still holds the turns after.
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
    return last.map((at): ForkPoint =>
      at === null
        ? null
        : { sessionId, at, model: source.model, cwd: source.cwd },
    );
  };

  // The main thread's reference, read as the app reads one for a cloud side chat: its newest turns, and its oldest one when there are more.
  const referenceOf = (parentId: string) =>
    Result.gen(async function* () {
      const newest = yield* Result.await(readPage(parentId, NEWEST));
      const recent = [...newest.turns].reverse();
      if (!newest.more) {
        return Result.ok(
          sideChatReference(recent, { agent: "Codex", model: null }),
        );
      }

      const oldest = yield* Result.await(readPage(parentId, OLDEST));
      const first = oldest.turns[0];
      // An oldest page with no turn though more were said to exist fails the read rather than hand over a mix.
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
    });

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
    { parent, instructions, model, kept }: Opened,
  ) => {
    const record =
      kept === null
        ? null
        : savedOf(threadId, parent, instructions, model, kept.claudeThread);
    sideChats.set(threadId, {
      parent,
      choice: model,
      ranOnCodex: false,
      stopped: false,
      saved: record,
    });
    noteSideChat(threadId, {
      instructions,
      reference: "reference" in parent ? parent.reference : null,
    });
    if (record !== null) void keep(saved.save(record));
  };

  // A side chat the server kept through a restart is taken up again where it stood, as the app opens it again with its first message still unsent.
  const restore = () => {
    for (const record of saved.all()) {
      if (claudeBegun(record.threadId)) {
        void keep(saved.remove(record.threadId));
        continue;
      }

      const { point } = record;
      const source =
        point === null || point === "unread"
          ? null
          : { sessionId: point.sessionId, at: point.at };
      if (record.claude !== null) {
        void restoreFork(record.threadId, record.claude, source);
      }

      noteSideChat(record.threadId, {
        instructions: record.instructions,
        reference: null,
      });
      sideChats.set(record.threadId, {
        parent:
          point === "unread"
            ? { agent: "Claude", unread: true }
            : { agent: "Claude", point },
        choice: record.choice ?? undefined,
        ranOnCodex: false,
        // Without where the main conversation stood, a restored side chat could not tell what to hand over.
        stopped: record.stopped || point === "unread",
        saved: record,
      });
    }
  };

  const keeps = () => saved.writable;

  const release = (threadId: string, ended: ThreadEnd) => {
    if (ended !== "deleted") return;
    const record = sideChats.get(threadId)?.saved;
    sideChats.delete(threadId);
    if (record != null) void keep(saved.remove(threadId));
  };

  // What a side chat's turn waits on before it runs: a refusal, the hand-over of the main conversation, or nothing.
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

    // A model picked before the first message only marks the choice, so picking the other agent again leaves the side chat as it was.
    sideChat.choice = requested;
    if (sideChat.saved !== null && sideChat.saved.choice !== requested) {
      sideChat.saved = { ...sideChat.saved, choice: requested };
      void keep(saved.save(sideChat.saved));
    }

    if (claude || !isClaudeThread(threadId)) return null;
    // A Codex main thread's side chat taken up by Claude before its first message goes back to the server's thread.
    if (sideChat.parent.agent === "Codex") dropFork(threadId);
    return "pass";
  };

  const isStopped = (threadId: string) =>
    sideChats.get(threadId)?.stopped === true;

  // The Codex model a Claude side chat was switched to before its first message, which the server's answers then report.
  const codexChoiceOf = (threadId: string): string | undefined => {
    const choice = current(threadId)?.choice;
    return choice !== undefined && !isClaudeModel(choice) ? choice : undefined;
  };

  const showsCodex = (threadId: string) =>
    codexChoiceOf(threadId) !== undefined;

  const current = (threadId: string) => {
    const sideChat = sideChats.get(threadId);
    if (sideChat === undefined || sideChat.stopped) return sideChat;
    if (!claudeBegun(threadId)) return sideChat;
    sideChats.delete(threadId);
    if (sideChat.saved !== null) void keep(saved.remove(threadId));
    return undefined;
  };

  const runsOnClaude = (threadId: string, model: string | undefined) =>
    // A turn naming no model runs where the side chat runs now.
    model === undefined ? isClaudeThread(threadId) : isClaudeModel(model);

  const handOver = async (
    threadId: string,
    sideChat: SideChat,
    point: ForkPoint,
  ) => {
    const brief = await briefOf(threadId, point);
    if (brief.isErr()) return "side_chat_not_briefed" as const;
    if (brief.value !== null) {
      // Saved before the brief is written, so a restart in the middle finds a hand-over of unknown outcome rather than one that may be written twice.
      if (!(await setStopped(sideChat, true))) {
        return "side_chat_not_briefed" as const;
      }

      const injected = await inject(threadId, [brief.value]);
      if (injected.isErr()) {
        // A failure that wrote nothing leaves the side chat as it was, so the message can be sent again; one whose outcome is unknown may have written the brief, so the side chat takes no more messages rather than risk a second copy or none.
        if (injected.error._tag !== "ServerRequestUnanswered") {
          await setStopped(sideChat, false);
          return "side_chat_not_briefed" as const;
        }

        sideChat.stopped = true;
        return "side_chat_stopped" as const;
      }
    }

    sideChat.ranOnCodex = true;
    if (sideChat.saved !== null) void keep(saved.remove(threadId));
    dropFork(threadId);
    return null;
  };

  const setStopped = async (sideChat: SideChat, stopped: boolean) => {
    const before = sideChat.saved;
    if (before === null) return true;
    sideChat.saved = { ...before, stopped };
    const result = await keep(saved.save(sideChat.saved));
    if (result.isOk()) return true;
    // The store follows a change even when its write fails, so the earlier state is saved again rather than left to a later write.
    sideChat.saved = before;
    void keep(saved.save(before));
    return false;
  };

  const keep = async (saving: ReturnType<SideChatStore["save"]>) => {
    const result = await saving;
    if (result.isErr()) {
      log({
        event: "side_chat_not_saved",
        error: result.error.reason,
      });
    }

    return result;
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

  restore();

  return {
    pointOf,
    referenceOf,
    remember,
    keeps,
    release,
    beforeTurn,
    beforeSettings,
    isStopped,
    codexChoiceOf,
    showsCodex,
  };
};

const movesAway = (parent: Parent, claude: boolean) =>
  claude !== (parent.agent === "Claude");

const savedOf = (
  threadId: string,
  parent: Parent,
  instructions: string | null,
  choice: string | undefined,
  claude: Thread | null,
): SavedSideChat | null => {
  if (parent.agent !== "Claude") return null;
  return {
    threadId,
    claude,
    point: "unread" in parent ? "unread" : parent.point,
    instructions,
    choice: choice ?? null,
    stopped: false,
  };
};

// The app reads this many of a main thread's newest turns for a cloud side chat.
const NEWEST = { limit: 50, sortDirection: "desc" } as const;

const OLDEST = { limit: 1, sortDirection: "asc" } as const;
