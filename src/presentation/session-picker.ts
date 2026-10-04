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

type PromptTarget = { threadId: string; turnId: string; itemId: string };

// The app returns a choice's label and typed text alike, so a page offers only choices, each label distinct, and searching asks for the words in a question of its own.
export const pickerPrompt = (
  target: PromptTarget,
  page: PickerPage,
  now: number,
) => {
  const more = page.total - page.offset - page.conversations.length;
  const labels = distinctLabels(
    page.conversations.map(({ title }) => shortTitle(title)),
    [SEARCH, ...(more > 0 ? [OLDER] : [])],
  );
  return {
    method: REQUEST_USER_INPUT,
    params: userInputParams(target, {
      id: PICK_QUESTION,
      header: "Resume",
      question: questionOf(page),
      isOther: false,
      isSecret: false,
      options: [
        ...page.conversations.map((conversation, index) => ({
          label: labels[index] ?? "",
          description: detailsOf(conversation, now),
        })),
        ...(more > 0 ? [{ label: OLDER, description: `${more} more` }] : []),
        {
          label: SEARCH,
          description:
            "Find conversations by words from a title or a session id",
        },
      ],
    }),
    answerOf: (
      answer: unknown,
    ): Exclude<PickerAnswer, { kind: "search" }> | { kind: "searching" } => {
      const chosen = answerTo(answer, PICK_QUESTION);
      if (chosen === SEARCH) return { kind: "searching" };
      if (more > 0 && chosen === OLDER) return { kind: "older" };
      const index = chosen === null ? -1 : labels.indexOf(chosen);
      return index >= 0 ? { kind: "picked", index } : { kind: "none" };
    },
  };
};

export const searchPrompt = (target: PromptTarget) => ({
  method: REQUEST_USER_INPUT,
  params: userInputParams(target, {
    id: SEARCH_QUESTION,
    header: "Resume",
    question:
      "Type words from a conversation's title, or its session id, to list the conversations that match.",
    isOther: true,
    isSecret: false,
    options: null,
  }),
  answerOf: (answer: unknown): PickerAnswer => {
    const typed = answerTo(answer, SEARCH_QUESTION);
    return typed === null ? { kind: "none" } : { kind: "search", text: typed };
  },
});

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

const userInputParams = <Q extends object>(
  target: PromptTarget,
  question: Q,
) => ({
  ...target,
  questions: [question],
  isBlocking: true,
  autoResolutionMs: null,
});

const answerTo = (answer: unknown, id: string) => {
  if (!isObject(answer) || !isObject(answer.answers)) return null;
  const entry = answer.answers[id];
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

const PICK_QUESTION = "conversation";

const SEARCH_QUESTION = "search";

const OLDER = "Older conversations";

const SEARCH = "Search";

const TITLE_LIMIT = 80;

const ORIGINS: Record<string, string> = {
  cli: "CLI",
  "claude-desktop": "Claude Desktop",
  "claude-vscode": "VS Code",
  "sdk-ts": "Agent SDK",
  "sdk-py": "Agent SDK",
  "sdk-cli": "Agent SDK",
};
