import type { InferErr } from "better-result";
import type { claudeSessionExists } from "../../infra/claude/session.ts";
import type {
  ClaudeConversation,
  listClaudeConversations,
  readLastRecordUuid,
} from "../../infra/claude/transcripts.ts";
import type {
  PickerAnswer,
  PickerPage,
} from "../../presentation/session-picker.ts";
import type { SessionReply } from "../../presentation/session-reply.ts";
import type { ThreadValues } from "../thread-values.ts";

export type SessionCommand =
  | { kind: "resume"; search: string | null }
  | { kind: "session" };

// Asks the user to pick from a page of the list; it answers none once the turn is stopped.
type AskPick = (page: PickerPage) => Promise<PickerAnswer>;

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

type ErrorTagOf<F extends (...args: never[]) => unknown> =
  InferErr<Awaited<ReturnType<F>>> extends { _tag: infer T } ? T : never;

type RecordErrorTag = ErrorTagOf<LastRecordOf>;

type BindErrorTag = NonNullable<
  Awaited<ReturnType<ThreadValues["bindSession"]>>["error"]
>;

type SessionErrorTag = ErrorTagOf<ListConversations> | BindErrorTag;

// Answers the bridge's session commands, and notices when a thread's conversation was continued elsewhere.
export const createSessionCommands = ({
  threads,
  listConversations,
  lastRecordOf,
  findSession,
  log,
  now,
}: {
  threads: Pick<ThreadValues, "sessionIdOf" | "isBound" | "bindSession">;
  listConversations: ListConversations;
  lastRecordOf: LastRecordOf;
  findSession: FindSession;
  log: (event: SessionEvent) => void;
  now: () => number;
}) => {
  // The last record each thread's own turn left, so a record that moved on before the next turn was continued elsewhere, such as by claude --resume.
  const lastRecords = new Map<string, string>();

  const answer = async (
    threadId: string,
    cwd: string,
    command: SessionCommand,
    ask: AskPick,
  ): Promise<SessionReply> => {
    const { reply, error } = await run(threadId, cwd, command, ask);
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
    ask: AskPick,
  ): Promise<{ reply: SessionReply; error: SessionErrorTag | null }> => {
    switch (command.kind) {
      case "session":
        return answered({
          kind: "session",
          cwd,
          sessionId: threads.sessionIdOf(threadId),
        });
      case "resume":
        return resume(threadId, cwd, command.search, ask);
    }
  };

  const resume = async (
    threadId: string,
    cwd: string,
    search: string | null,
    ask: AskPick,
  ) => {
    // A thread with a conversation would lose it, so only an empty thread lists others.
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
    if (found.value.length === 0) {
      return answered({ kind: "noneFound", cwd, maxAgeDays: MAX_AGE_DAYS });
    }
    return pick(
      threadId,
      cwd,
      ask,
      found.value,
      searched(found.value, search),
      0,
    );
  };

  const pick = async (
    threadId: string,
    cwd: string,
    ask: AskPick,
    all: readonly ClaudeConversation[],
    view: SearchedList,
    offset: number,
  ): Promise<{ reply: SessionReply; error: SessionErrorTag | null }> => {
    const shown = view.matches.slice(offset, offset + PAGE_SIZE);
    const answer = await ask({
      cwd,
      maxAgeDays: MAX_AGE_DAYS,
      conversations: shown.map((conversation) => ({
        ...conversation,
        // A conversation another thread continues stays listed so it is not mistaken for a missing one.
        continued: threads.isBound(conversation.sessionId),
      })),
      offset,
      total: view.matches.length,
      search: view.search,
      unmatched: view.unmatched,
    });
    switch (answer.kind) {
      case "none":
        return answered({ kind: "notPicked" });
      case "newer":
        return pick(threadId, cwd, ask, all, view, offset - PAGE_SIZE);
      case "older":
        return pick(threadId, cwd, ask, all, view, offset + PAGE_SIZE);
      case "search":
        return pick(threadId, cwd, ask, all, searched(all, answer.text), 0);
      case "picked": {
        const chosen = shown[answer.index];
        return chosen === undefined
          ? answered({ kind: "notPicked" })
          : select(threadId, chosen);
      }
    }
  };

  const select = async (threadId: string, chosen: ClaudeConversation) => {
    if (threads.sessionIdOf(threadId) !== null) {
      return answered({ kind: "hasConversation" });
    }
    // Another thread may have taken the conversation, or Claude may have lost its record, since the list was shown.
    if (threads.isBound(chosen.sessionId)) return answered({ kind: "taken" });
    const found = await findSession(chosen.sessionId);
    if (found.isOk() && !found.value) return answered({ kind: "recordGone" });
    const { bound, error } = await threads.bindSession(
      threadId,
      chosen.sessionId,
    );
    if (!bound) {
      const reply: SessionReply =
        error === "SessionTaken" ? { kind: "taken" } : { kind: "notSaved" };
      return { reply, error };
    }
    await remember(threadId, chosen.sessionId);
    return {
      reply: {
        kind: "selected",
        title: chosen.title,
        name: chosen.name,
        unsynced: error !== null,
      } as const,
      error,
    };
  };

  const remember = async (threadId: string, sessionId: string | null) => {
    lastRecords.delete(threadId);
    const last = sessionId === null ? null : await readLast(sessionId);
    // A record that cannot be read is not compared, so the next turn is not wrongly reported as continued elsewhere.
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

  return { answer, remember, forget, advanced };
};

export const sessionCommandOf = (
  typed: string | null,
): SessionCommand | null => {
  const command = typed?.trim() ?? "";
  if (command === "/session") return { kind: "session" };
  const resume = command.match(RESUME);
  if (resume === null) return null;
  return { kind: "resume", search: resume[1]?.trim() || null };
};

type SearchedList = {
  matches: readonly ClaudeConversation[];
  search: string | null;
  unmatched: string | null;
};

const searched = (
  all: readonly ClaudeConversation[],
  text: string | null,
): SearchedList => {
  if (text === null) return { matches: all, search: null, unmatched: null };
  const byId = all.filter(({ sessionId }) => sessionId === text);
  const words = text.toLowerCase().split(/\s+/);
  const matches =
    byId.length > 0
      ? byId
      : all.filter(({ title, name }) => {
          const held = `${title}\n${name ?? ""}`.toLowerCase();
          return words.every((word) => held.includes(word));
        });
  return matches.length > 0
    ? { matches, search: text, unmatched: null }
    : { matches: all, search: null, unmatched: text };
};

const answered = (reply: SessionReply) => ({ reply, error: null });

const MAX_AGE_DAYS = 14;

const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60_000;

// Six conversations, the ways to newer and older ones and searching keep a page to nine choices.
const PAGE_SIZE = 6;

const RESUME = /^\/resume(?:\s+(.*))?$/s;
