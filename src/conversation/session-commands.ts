import type { InferErr } from "better-result";
import type { claudeSessionExists } from "../infra/claude/session.ts";
import type {
  ClaudeConversation,
  listClaudeConversations,
  readLastRecordUuid,
} from "../infra/claude/transcripts.ts";
import type { ThreadStore } from "../infra/thread-store.ts";
import type { SessionReply } from "../presentation/session-reply.ts";

export type SessionCommand =
  | { kind: "list" }
  | { kind: "session" }
  | { kind: "select"; picked: number; listing: readonly ClaudeConversation[] };

// Only the command, the reply's kind and error tags are logged, never a title or a session id.
export type SessionEvent =
  | {
      event: "claude_turn";
      step: "session_command";
      command: SessionCommand["kind"];
      reply: SessionReply["kind"];
      error: SessionErrorTag | null;
    }
  | { event: "claude_turn"; step: "record_advanced" }
  | { event: "claude_turn"; step: "record_unreadable"; error: RecordErrorTag };

type ListConversations = (
  cwd: string,
  since: number,
) => ReturnType<typeof listClaudeConversations>;

type LastRecordOf = (
  sessionId: string,
) => ReturnType<typeof readLastRecordUuid>;

type FindSession = (
  sessionId: string,
) => ReturnType<typeof claudeSessionExists>;

type BindSession = (
  threadId: string,
  sessionId: string,
) => ReturnType<ThreadStore["setSessionId"]>;

type ErrorTagOf<F extends (...args: never[]) => unknown> =
  InferErr<Awaited<ReturnType<F>>> extends { _tag: infer T } ? T : never;

type RecordErrorTag = ErrorTagOf<LastRecordOf>;

type BindErrorTag = ErrorTagOf<BindSession>;

type SessionErrorTag = ErrorTagOf<ListConversations> | BindErrorTag;

// The last record each thread's own turn left, so a record that moved on before the next turn was continued elsewhere, such as by claude --resume.
export const createSessionCommands = ({
  threads,
  listConversations,
  lastRecordOf,
  findSession,
  log,
  now,
}: {
  threads: {
    sessionIdOf: (threadId: string) => string | null;
    isBound: (sessionId: string) => boolean;
    bindSession: BindSession;
  };
  listConversations: ListConversations;
  lastRecordOf: LastRecordOf;
  findSession: FindSession;
  log: (event: SessionEvent) => void;
  now: () => number;
}) => {
  const listings = new Map<string, readonly ClaudeConversation[]>();
  const lastRecords = new Map<string, string>();

  // Every turn takes the thread's list, so a number picks from it only in the turn right after it; typed is null for a turn the user did not type.
  const take = (threadId: string, typed: string | null) => {
    const listing = listings.get(threadId);
    listings.delete(threadId);
    return typed === null ? null : commandOf(typed.trim(), listing);
  };

  const answer = async (
    threadId: string,
    cwd: string,
    command: SessionCommand,
  ): Promise<SessionReply> => {
    const { reply, error } = await run(threadId, cwd, command);
    log({
      event: "claude_turn",
      step: "session_command",
      command: command.kind,
      reply: reply.kind,
      error,
    });
    return reply;
  };

  const run = async (
    threadId: string,
    cwd: string,
    command: SessionCommand,
  ): Promise<{ reply: SessionReply; error: SessionErrorTag | null }> => {
    switch (command.kind) {
      case "session":
        return {
          reply: {
            kind: "session",
            cwd,
            sessionId: threads.sessionIdOf(threadId),
          },
          error: null,
        };
      case "list":
        return list(threadId, cwd);
      case "select":
        return select(threadId, command.picked, command.listing);
    }
  };

  // A thread with a conversation would lose it, so only an empty thread lists others.
  const list = async (threadId: string, cwd: string) => {
    if (threads.sessionIdOf(threadId) !== null) {
      return answered({ kind: "hasConversation" });
    }
    const found = await listConversations(cwd, now() - MAX_AGE_MS);
    if (found.isErr()) {
      return {
        reply: { kind: "listUnreadable" } as const,
        error: found.error._tag,
      };
    }
    const open = found.value
      .filter((conversation) => !threads.isBound(conversation.sessionId))
      .slice(0, LIST_LIMIT);
    if (open.length > 0) listings.set(threadId, open);
    return answered({
      kind: "listed",
      cwd,
      maxAgeDays: MAX_AGE_DAYS,
      conversations: open,
    });
  };

  // Another thread may have taken the conversation, or Claude may have lost its record, since the list was shown.
  const select = async (
    threadId: string,
    picked: number,
    listing: readonly ClaudeConversation[],
  ) => {
    if (threads.sessionIdOf(threadId) !== null) {
      return answered({ kind: "hasConversation" });
    }
    const chosen = picked >= 1 ? listing[picked - 1] : undefined;
    if (chosen === undefined) {
      return answered({ kind: "noSuchNumber", picked, count: listing.length });
    }
    if (threads.isBound(chosen.sessionId)) return answered({ kind: "taken" });
    const found = await findSession(chosen.sessionId);
    if (found.isOk() && !found.value) return answered({ kind: "recordGone" });
    const bound = await threads.bindSession(threadId, chosen.sessionId);
    if (bound.isErr()) {
      return { reply: { kind: "notSaved" } as const, error: bound.error._tag };
    }
    await remember(threadId, chosen.sessionId);
    return answered({ kind: "selected", title: chosen.title });
  };

  // A record that cannot be read is not compared, so the next turn is not wrongly reported as continued elsewhere.
  const remember = async (threadId: string, sessionId: string | null) => {
    lastRecords.delete(threadId);
    const last = sessionId === null ? null : await readLast(sessionId);
    if (last !== null) lastRecords.set(threadId, last);
  };

  const forget = (threadId: string) => {
    lastRecords.delete(threadId);
  };

  const advanced = async (threadId: string, sessionId: string | null) => {
    const remembered = lastRecords.get(threadId);
    if (remembered === undefined || sessionId === null) return false;
    const last = await readLast(sessionId);
    if (last === null || last === remembered) return false;
    log({ event: "claude_turn", step: "record_advanced" });
    return true;
  };

  const readLast = async (sessionId: string) => {
    const read = await lastRecordOf(sessionId);
    if (read.isOk()) return read.value;
    log({
      event: "claude_turn",
      step: "record_unreadable",
      error: read.error._tag,
    });
    return null;
  };

  return { take, answer, remember, forget, advanced };
};

const commandOf = (
  typed: string,
  listing: readonly ClaudeConversation[] | undefined,
): SessionCommand | null => {
  if (typed === "/resume") return { kind: "list" };
  if (typed === "/session") return { kind: "session" };
  return listing !== undefined && /^\d+$/.test(typed)
    ? { kind: "select", picked: Number(typed), listing }
    : null;
};

const answered = (reply: SessionReply) => ({ reply, error: null });

const MAX_AGE_DAYS = 14;

const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60_000;

const LIST_LIMIT = 10;
