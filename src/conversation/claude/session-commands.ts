import type { InferErr } from "better-result";
import { CREDENTIALS_ENV, terminalEnv } from "../../infra/claude/auth.ts";
import {
  type Connection,
  type ConnectionTarget,
  sameTarget,
  targetOf,
} from "../../infra/claude/connection.ts";
import type { createConnectionResolver } from "../../infra/claude/connection-settings.ts";
import type { claudeSessionExists } from "../../infra/claude/session.ts";
import type {
  ClaudeConversation,
  listClaudeConversations,
  readLastRecordUuid,
} from "../../infra/claude/transcripts.ts";
import type { SessionConnection } from "../../presentation/connection.ts";
import type {
  PickerAnswer,
  PickerPage,
} from "../../presentation/session-picker.ts";
import type { SessionReply } from "../../presentation/session-reply.ts";
import type { ThreadValues } from "../thread-values.ts";

export type SessionCommand =
  | { kind: "resume"; search: string | null }
  | { kind: "session" }
  | { kind: "switchConnection" };

// Asks the user to pick from a page of the list; it answers none once the turn is stopped.
export type AskPick = (page: PickerPage) => Promise<PickerAnswer>;

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

export type ResolveConnection = ReturnType<typeof createConnectionResolver>;

type ErrorTagOf<F extends (...args: never[]) => unknown> =
  InferErr<Awaited<ReturnType<F>>> extends { _tag: infer T } ? T : never;

type RecordErrorTag = ErrorTagOf<LastRecordOf>;

type BindErrorTag = NonNullable<
  Awaited<ReturnType<ThreadValues["bindSession"]>>["error"]
>;

type SessionErrorTag =
  | ErrorTagOf<ListConversations>
  | ErrorTagOf<ResolveConnection>
  | BindErrorTag;

// The last record each thread's own turn left, so a record that moved on before the next turn was continued elsewhere, such as by claude --resume.
export const createSessionCommands = ({
  threads,
  listConversations,
  lastRecordOf,
  findSession,
  resolveConnection,
  log,
  now,
}: {
  threads: Pick<
    ThreadValues,
    "sessionIdOf" | "isBound" | "bindSession" | "connectionOf" | "setConnection"
  >;
  listConversations: ListConversations;
  lastRecordOf: LastRecordOf;
  findSession: FindSession;
  resolveConnection: ResolveConnection;
  log: (event: SessionEvent) => void;
  now: () => number;
}) => {
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
        return session(threadId, cwd);
      case "switchConnection":
        return switchConnection(threadId, cwd);
      case "resume":
        return resume(threadId, cwd, command.search, ask);
    }
  };

  const session = async (threadId: string, cwd: string) => {
    const saved = threads.connectionOf(threadId);
    const configured = await resolveConnection(cwd);
    const connection: SessionConnection = configured.isErr()
      ? {
          kind: "unreadable",
          saved,
          problem: configured.error.message,
          ...resumeOn(saved),
        }
      : compared(saved, configured.value);
    return {
      reply: {
        kind: "session",
        cwd,
        sessionId: threads.sessionIdOf(threadId),
        connection,
      } as const,
      error: configured.isErr() ? configured.error._tag : null,
    };
  };

  // The saved connection is cleared rather than replaced, so the next turn has Claude Code confirm the new one and shows it as a first connection.
  const switchConnection = async (threadId: string, cwd: string) => {
    const configured = await resolveConnection(cwd);
    if (configured.isErr()) {
      return {
        reply: {
          kind: "connectionUnreadable",
          problem: configured.error.message,
        } as const,
        error: configured.error._tag,
      };
    }
    const saved = threads.connectionOf(threadId);
    const to = targetOf(configured.value);
    if (saved === null || sameTarget(saved, to)) {
      return answered({ kind: "connectionUnchanged" });
    }
    return (await threads.setConnection(threadId, null))
      ? answered({ kind: "connectionSwitched", to })
      : answered({ kind: "connectionNotSaved" });
  };

  // A thread with a conversation would lose it, so only an empty thread lists others.
  const resume = async (
    threadId: string,
    cwd: string,
    search: string | null,
    ask: AskPick,
  ) => {
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

  // A conversation another thread continues stays listed so it is not mistaken for a missing one.
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

  // Another thread may have taken the conversation, or Claude may have lost its record, since the list was shown.
  const select = async (threadId: string, chosen: ClaudeConversation) => {
    if (threads.sessionIdOf(threadId) !== null) {
      return answered({ kind: "hasConversation" });
    }
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

  return { answer, remember, forget, advanced };
};

export const sessionCommandOf = (
  typed: string | null,
): SessionCommand | null => {
  const command = typed?.trim() ?? "";
  if (command === "/session") return { kind: "session" };
  if (command === "/switch-connection") return { kind: "switchConnection" };
  const resume = command.match(RESUME);
  if (resume === null) return null;
  return { kind: "resume", search: resume[1]?.trim() || null };
};

type SearchedList = {
  matches: readonly ClaudeConversation[];
  search: string | null;
  unmatched: string | null;
};

// A session id finds its own conversation, and words find those whose title or name holds them all in any case; finding none lists every conversation again.
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

const compared = (
  saved: ConnectionTarget | null,
  configured: Connection,
): SessionConnection => {
  const target = targetOf(configured);
  if (saved !== null && !sameTarget(saved, target)) {
    return { kind: "changed", saved, configured: target, ...resumeOn(saved) };
  }
  return {
    kind: "same",
    saved,
    configured: target,
    ...(saved?.provider === "vertex" && configured.provider === "vertex"
      ? {
          resumeEnv: terminalEnv(configured),
          credentialsFile: CREDENTIALS_ENV in configured.env,
        }
      : resumeOn(saved)),
  };
};

// Without these variables claude --resume would continue the conversation on the terminal's own login.
const resumeOn = (saved: ConnectionTarget | null) => ({
  resumeEnv:
    saved?.provider === "vertex"
      ? terminalEnv({
          ...saved,
          env: {
            CLAUDE_CODE_USE_VERTEX: "1",
            ANTHROPIC_VERTEX_PROJECT_ID: saved.projectId,
            CLOUD_ML_REGION: saved.region,
          },
        })
      : [],
  credentialsFile: false,
});

const answered = (reply: SessionReply) => ({ reply, error: null });

const MAX_AGE_DAYS = 14;

const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60_000;

// Seven conversations, the way to older ones and searching keep a page to nine choices.
const PAGE_SIZE = 7;

const RESUME = /^\/resume(?:\s+(.*))?$/s;
