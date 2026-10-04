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
import type { SessionReply } from "../../presentation/session-reply.ts";
import type { ThreadValues } from "../thread-values.ts";

export type SessionCommand =
  | { kind: "list" }
  | { kind: "session" }
  | { kind: "switchConnection" }
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
        return session(threadId, cwd);
      case "switchConnection":
        return switchConnection(threadId, cwd);
      case "list":
        return list(threadId, cwd);
      case "select":
        return select(threadId, command.picked, command.listing);
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
    // A conversation another thread continues stays listed so it is not mistaken for a missing one.
    const recent = found.value.slice(0, LIST_LIMIT);
    if (recent.length > 0) listings.set(threadId, recent);
    return answered({
      kind: "listed",
      cwd,
      maxAgeDays: MAX_AGE_DAYS,
      conversations: recent.map((conversation) => ({
        ...conversation,
        continued: threads.isBound(conversation.sessionId),
      })),
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

  return { take, answer, remember, forget, advanced };
};

const commandOf = (
  typed: string,
  listing: readonly ClaudeConversation[] | undefined,
): SessionCommand | null => {
  if (typed === "/resume") return { kind: "list" };
  if (typed === "/session") return { kind: "session" };
  if (typed === "/switch-connection") return { kind: "switchConnection" };
  return listing !== undefined && /^\d+$/.test(typed)
    ? { kind: "select", picked: Number(typed), listing }
    : null;
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

const LIST_LIMIT = 10;
