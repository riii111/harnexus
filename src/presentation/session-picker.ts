import { isObject } from "../runtime/object.ts";

// One page of the conversations /resume offers; offset and total place it in the list, which holds only those matching search, or every one when unmatched found none.
export type PickerPage = {
  cwd: string;
  maxAgeDays: number;
  conversations: readonly ListedConversation[];
  offset: number;
  total: number;
  search: string | null;
  unmatched: string | null;
};

export type ListedConversation = {
  title: string;
  updatedAtMs: number;
  entrypoint: string | null;
  worktree: string | null;
  continued: boolean;
};

export type PickerAnswer =
  | { kind: "picked"; index: number }
  | { kind: "older" }
  | { kind: "search"; text: string }
  | { kind: "none" };

// The app keys a choice by its label and returns it, or the text typed instead, so every label on a page differs.
export const pickerPrompt = (
  target: { threadId: string; turnId: string; itemId: string },
  page: PickerPage,
  now: number,
) => {
  const more = page.total - page.offset - page.conversations.length;
  const labels = distinctLabels(
    page.conversations.map(({ title }) => shortTitle(title)),
    more > 0 ? [OLDER] : [],
  );
  const options = [
    ...page.conversations.map((conversation, index) => ({
      label: labels[index] ?? "",
      description: detailsOf(conversation, now),
    })),
    ...(more > 0 ? [{ label: OLDER, description: `${more} more` }] : []),
  ];
  return {
    method: REQUEST_USER_INPUT,
    params: {
      ...target,
      questions: [
        {
          id: QUESTION_ID,
          header: "Resume",
          question: questionOf(page),
          isOther: true,
          isSecret: false,
          options,
        },
      ],
      isBlocking: true,
      autoResolutionMs: null,
    },
    answerOf: (answer: unknown): PickerAnswer => {
      const typed = answerTo(answer);
      if (typed === null) return { kind: "none" };
      if (more > 0 && typed === OLDER) return { kind: "older" };
      const index = labels.indexOf(typed);
      return index >= 0
        ? { kind: "picked", index }
        : { kind: "search", text: typed };
    },
  };
};

export const shortTitle = (title: string) => {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length <= TITLE_LIMIT
    ? line
    : `${line.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
};

const questionOf = ({
  cwd,
  maxAgeDays,
  conversations,
  offset,
  total,
  search,
  unmatched,
}: PickerPage) =>
  [
    ...(unmatched === null
      ? []
      : [`No conversation matches "${unmatched}", so all are listed.`]),
    `Which Claude Code conversation from the last ${maxAgeDays} days in ${cwd} or its Claude Code worktrees should this thread continue?`,
    ...(search === null ? [] : [`Only those matching "${search}" are listed.`]),
    ...(total > conversations.length
      ? [`Showing ${offset + 1}–${offset + conversations.length} of ${total}.`]
      : []),
    "To search, type words from a title or a session id.",
  ].join(" ");

const detailsOf = (conversation: ListedConversation, now: number) =>
  [
    ago(conversation.updatedAtMs, now),
    originOf(conversation.entrypoint),
    ...(conversation.worktree === null
      ? []
      : [`worktree ${conversation.worktree}`]),
    ...(conversation.continued ? ["continued in another thread"] : []),
  ].join(" · ");

// A label already taken gets the first number that makes it distinct.
const distinctLabels = (labels: string[], reserved: string[]) => {
  const taken = new Set(reserved);
  return labels.map((label) => {
    let distinct = label;
    for (let suffix = 2; taken.has(distinct); suffix += 1) {
      distinct = `${label} (${suffix})`;
    }
    taken.add(distinct);
    return distinct;
  });
};

const answerTo = (answer: unknown) => {
  if (!isObject(answer) || !isObject(answer.answers)) return null;
  const entry = answer.answers[QUESTION_ID];
  if (!isObject(entry) || !Array.isArray(entry.answers)) return null;
  const [first] = entry.answers;
  const typed = typeof first === "string" ? first.trim() : "";
  return typed === "" ? null : typed;
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

const REQUEST_USER_INPUT = "item/tool/requestUserInput";

const QUESTION_ID = "conversation";

const OLDER = "Older conversations";

const TITLE_LIMIT = 80;

const ORIGINS: Record<string, string> = {
  cli: "CLI",
  "claude-desktop": "Claude Desktop",
  "claude-vscode": "VS Code",
  "sdk-ts": "Agent SDK",
  "sdk-py": "Agent SDK",
  "sdk-cli": "Agent SDK",
};
