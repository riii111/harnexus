import {
  type ConnectionView,
  type SessionConnection,
  sessionConnectionLines,
  switchedText,
} from "./connection.ts";
import { shortTitle } from "./session-picker.ts";

// The bridge answers /resume, the pick it asks for, /session and /switch-connection itself, so none of these replies reaches Claude.
export type SessionReply =
  | { kind: "noneFound"; cwd: string; maxAgeDays: number }
  | { kind: "listUnreadable" }
  | { kind: "hasConversation" }
  | { kind: "notPicked" }
  | { kind: "taken" }
  | { kind: "recordGone" }
  | { kind: "notSaved" }
  | { kind: "selected"; title: string; name: string | null; unsynced: boolean }
  | {
      kind: "session";
      cwd: string;
      sessionId: string | null;
      connection: SessionConnection;
    }
  | { kind: "connectionSwitched"; to: ConnectionView }
  | { kind: "connectionUnchanged" }
  | { kind: "connectionNotSaved" }
  | { kind: "connectionUnreadable"; problem: string };

export const sessionReplyText = (reply: SessionReply): string => {
  switch (reply.kind) {
    case "noneFound":
      return `No Claude Code conversation from the last ${reply.maxAgeDays} days in \`${reply.cwd}\` or its Claude Code worktrees can be continued here.`;
    case "listUnreadable":
      return "Harnexus cannot read Claude Code's conversation records, so no conversation can be listed.";
    case "hasConversation":
      return "This thread already has a Claude conversation, so another one cannot be continued here; create a new Claude thread and send /resume there.";
    case "notPicked":
      return "No conversation was picked, so this thread continues none. Send /resume to pick one.";
    case "taken":
      return "That conversation is already continued in another thread. Send /resume to pick another.";
    case "recordGone":
      return "Claude Code no longer has that conversation's record. Send /resume to pick another.";
    case "notSaved":
      return "Harnexus could not save the conversation for this thread, so it was not continued. Send /resume and pick it again to retry.";
    case "selected":
      return [
        `This thread now continues "${shortTitle(reply.title)}". Your next message goes to that Claude conversation; reopen the thread to see its earlier messages.`,
        ...(reply.unsynced
          ? [
              "Harnexus could not confirm the choice reached the disk, so it may be lost if the machine stops before the next save.",
            ]
          : []),
      ].join(" ");
    case "session":
      return sessionText(reply);
    case "connectionSwitched":
      return switchedText(reply.to);
    case "connectionUnchanged":
      return "This chat already uses the connection this repository's Claude Code settings choose, so nothing changed.";
    case "connectionNotSaved":
      return "Harnexus could not save the change, so this chat stays on its connection. Send /switch-connection again to retry.";
    case "connectionUnreadable":
      return `${reply.problem}. Nothing changed.`;
  }
};

export const RECORD_ADVANCED =
  "This Claude conversation was continued outside this thread since its last turn, such as with claude --resume; this turn continues from the latest record.";

const sessionText = ({
  cwd,
  sessionId,
  connection,
}: Extract<SessionReply, { kind: "session" }>) => {
  const connectionLines = sessionConnectionLines(connection);
  const extra = connectionLines.length === 0 ? [] : ["", ...connectionLines];
  if (sessionId === null) {
    return [
      "This thread has no Claude conversation yet. Send a message first, then /session again.",
      ...extra,
    ].join("\n");
  }
  const env = connection.resumeEnv
    .map(([name, value]) => `${name}=${shellQuote(value)} `)
    .join("");
  return [
    `Working directory: \`${cwd}\``,
    ...extra,
    "",
    "Continue this conversation in a terminal:",
    "",
    "```sh",
    `cd ${shellQuote(cwd)} && ${env}claude --resume ${shellQuote(sessionId)}`,
    "```",
    ...(connection.credentialsFile
      ? [
          "",
          "Also set GOOGLE_APPLICATION_CREDENTIALS as this repository's Claude Code settings do.",
        ]
      : []),
  ].join("\n");
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
