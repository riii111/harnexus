// The bridge answers /resume, a number picked from its list and /session itself, so none of these replies reaches Claude.
export type SessionReply =
  | {
      kind: "listed";
      cwd: string;
      maxAgeDays: number;
      conversations: readonly ListedConversation[];
    }
  | { kind: "listUnreadable" }
  | { kind: "hasConversation" }
  | { kind: "noSuchNumber"; picked: number; count: number }
  | { kind: "taken" }
  | { kind: "recordGone" }
  | { kind: "notSaved" }
  | { kind: "selected"; title: string; unsynced: boolean }
  | { kind: "session"; cwd: string; sessionId: string | null };

export type ListedConversation = {
  title: string;
  updatedAtMs: number;
  entrypoint: string | null;
};

export const sessionReplyText = (reply: SessionReply, now: number): string => {
  switch (reply.kind) {
    case "listed":
      return listText(reply, now);
    case "listUnreadable":
      return "Harnexus cannot read Claude Code's conversation records, so no conversation can be listed.";
    case "hasConversation":
      return "This thread already has a Claude conversation, so another one cannot be continued here; create a new Claude thread and send /resume there.";
    case "noSuchNumber":
      return `No conversation is numbered ${reply.picked}; the list had ${reply.count}. Send /resume to list them again.`;
    case "taken":
      return "That conversation is already continued in another thread. Send /resume to list the others.";
    case "recordGone":
      return "Claude Code no longer has that conversation's record. Send /resume to list the others.";
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
      return sessionText(reply.cwd, reply.sessionId);
  }
};

export const RECORD_ADVANCED =
  "This Claude conversation was continued outside this thread since its last turn, such as with claude --resume; this turn continues from the latest record.";

const listText = (
  { cwd, maxAgeDays, conversations }: Extract<SessionReply, { kind: "listed" }>,
  now: number,
) => {
  if (conversations.length === 0) {
    return `No Claude Code conversation from the last ${maxAgeDays} days in \`${cwd}\` can be continued here. Conversations already continued in a thread are not listed.`;
  }
  const lines = conversations.map(
    (conversation, index) =>
      `${index + 1}. ${shortTitle(conversation.title)} · ${ago(conversation.updatedAtMs, now)} · ${originOf(conversation.entrypoint)}`,
  );
  return [
    `Claude Code conversations from the last ${maxAgeDays} days in \`${cwd}\`:`,
    "",
    ...lines,
    "",
    "Send a number alone to continue that conversation in this thread.",
  ].join("\n");
};

const sessionText = (cwd: string, sessionId: string | null) =>
  sessionId === null
    ? "This thread has no Claude conversation yet. Send a message first, then /session again."
    : [
        `Working directory: \`${cwd}\``,
        "",
        "Continue this conversation in a terminal:",
        "",
        "```sh",
        `cd ${shellQuote(cwd)} && claude --resume ${shellQuote(sessionId)}`,
        "```",
      ].join("\n");

const shortTitle = (title: string) => {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length <= TITLE_LIMIT
    ? line
    : `${line.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
};

const ago = (at: number, now: number) => {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
};

const originOf = (entrypoint: string | null) =>
  entrypoint === null ? "unknown origin" : (ORIGINS[entrypoint] ?? entrypoint);

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const TITLE_LIMIT = 80;

const ORIGINS: Record<string, string> = {
  cli: "CLI",
  "claude-desktop": "Claude Desktop",
  "claude-vscode": "VS Code",
  "sdk-ts": "Agent SDK",
  "sdk-py": "Agent SDK",
  "sdk-cli": "Agent SDK",
};
