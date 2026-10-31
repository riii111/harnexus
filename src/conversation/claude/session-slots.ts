import type { InferOk } from "better-result";
import type { startClaudeSession } from "../../infra/claude/session.ts";
import type { createCodexLink } from "../../infra/codex/codex-link.ts";
import type { ThreadValues } from "../thread-values.ts";
import type { Inbox } from "./inbox.ts";

export type SessionStart = Awaited<ReturnType<typeof startClaudeSession>>;

export type ClaudeSession = InferOk<SessionStart>;

export type CodexLink = Pick<
  ReturnType<typeof createCodexLink>,
  | "server"
  | "allowedTools"
  | "hasUnsettledWrite"
  | "stopWrites"
  | "acceptWrites"
>;

export type StreamedMessage =
  ClaudeSession["messages"] extends AsyncGenerator<infer R> ? R : never;

export type StreamedNext = IteratorResult<StreamedMessage, void>;

// A session is not reused until its interrupt reports whether a send is still queued, which can arrive after the interrupted turn has ended.
export type SessionSlot = {
  session: ClaudeSession;
  model: string;
  pendingInterrupt: Promise<void> | null;
  link: CodexLink;
  attachedSkills: Map<string, string>;
  reader: Inbox<StreamedNext> | null;
  unclaimed: "own" | "turn" | null;
  discarding: boolean;
  backgroundTasks: number;
};

export type SessionStartup<Turn> = {
  turn: Turn;
  controller: AbortController;
  link: CodexLink | null;
};

export const createSessionSlots = <Turn extends { threadId: string }>({
  threads,
  idleSessionMs,
  log,
  onDropped,
}: {
  threads: Pick<ThreadValues, "sessionIdOf">;
  idleSessionMs: number;
  log: (event: { event: "claude_turn"; step: "idle_closed" }) => void;
  onDropped: (threadId: string) => void;
}) => {
  const sessions = new Map<string, SessionSlot>();
  const starting = new Map<string, SessionStartup<Turn>>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const beginStart = (turn: Turn): SessionStartup<Turn> => {
    const startup: SessionStartup<Turn> = {
      turn,
      controller: new AbortController(),
      link: null,
    };
    starting.set(turn.threadId, startup);
    return startup;
  };

  const clearStart = (threadId: string, startup: SessionStartup<Turn>) => {
    if (starting.get(threadId) === startup) {
      starting.delete(threadId);
    }
  };

  const cancelStart = (threadId: string, startup: SessionStartup<Turn>) => {
    if (starting.get(threadId) !== startup) return;
    starting.delete(threadId);
    startup.controller.abort();
    startup.link?.stopWrites();
  };

  // An idle session without a session id stays, since its next turn could not resume the conversation.
  // Closing would end the tasks Claude runs in the background, so the close waits until none is left.
  const scheduleIdleClose = (threadId: string) => {
    cancelIdleClose(threadId);
    const timer = setTimeout(() => {
      idleTimers.delete(threadId);
      const slot = sessions.get(threadId);
      if (slot === undefined) return;
      if (threads.sessionIdOf(threadId) == null) return;
      if (slot.backgroundTasks > 0) {
        scheduleIdleClose(threadId);
        return;
      }
      drop(threadId, slot);
      log({ event: "claude_turn", step: "idle_closed" });
    }, idleSessionMs);
    timer.unref();
    idleTimers.set(threadId, timer);
  };

  const cancelIdleClose = (threadId: string) => {
    clearTimeout(idleTimers.get(threadId));
    idleTimers.delete(threadId);
  };

  const drop = (threadId: string, slot: SessionSlot) => {
    if (sessions.get(threadId) === slot) {
      sessions.delete(threadId);
      onDropped(threadId);
    }
    slot.session.close();
  };

  const closeAll = () => {
    for (const threadId of [...idleTimers.keys()]) cancelIdleClose(threadId);
    for (const [threadId, startup] of [...starting]) {
      cancelStart(threadId, startup);
    }
    for (const [threadId, slot] of sessions) drop(threadId, slot);
  };

  return {
    slotOf: (threadId: string) => sessions.get(threadId),
    startingOf: (threadId: string) => starting.get(threadId),
    open: (threadId: string, slot: SessionSlot) => {
      sessions.set(threadId, slot);
    },
    beginStart,
    clearStart,
    cancelStart,
    scheduleIdleClose,
    cancelIdleClose,
    drop,
    close: (threadId: string) => {
      cancelIdleClose(threadId);
      const slot = sessions.get(threadId);
      if (slot !== undefined) drop(threadId, slot);
    },
    closeAll,
  };
};
