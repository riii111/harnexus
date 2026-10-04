import { describe, expect, test } from "bun:test";
import {
  type ListedConversation,
  type PickerPage,
  pickerPrompt,
  searchPrompt,
} from "./session-picker.ts";

describe("pickerPrompt", () => {
  test("gives conversations with the same title distinct labels and answers the one picked", () => {
    const prompt = pickerPrompt(
      TARGET,
      page([listed("same ask"), listed("same ask"), listed("same ask (2)")]),
      NOW,
    );

    expect(labelsOf(prompt)).toEqual([
      "same ask",
      "same ask (2)",
      "same ask (2) (2)",
      "Search",
    ]);
    expect(prompt.answerOf(picked("same ask (2)"))).toEqual({
      kind: "picked",
      index: 1,
    });
  });

  test("offers only choices, leaving searching to a choice of its own", () => {
    const prompt = pickerPrompt(TARGET, page([listed("ask")]), NOW);

    expect(prompt.params.questions[0]?.isOther).toBe(false);
    expect(prompt.answerOf(picked("Search"))).toEqual({ kind: "searching" });
  });

  test.each<{
    name: string;
    offset: number;
    expected: {
      labels: string[];
      newer: PageAnswerKind;
      older: PageAnswerKind;
    };
  }>([
    {
      name: "the first page",
      offset: 0,
      expected: {
        labels: ["ask", "Older conversations", "Search"],
        newer: "none",
        older: "older",
      },
    },
    {
      name: "a middle page",
      offset: 1,
      expected: {
        labels: ["ask", "Newer conversations", "Older conversations", "Search"],
        newer: "newer",
        older: "older",
      },
    },
    {
      name: "the last page",
      offset: 2,
      expected: {
        labels: ["ask", "Newer conversations", "Search"],
        newer: "newer",
        older: "none",
      },
    },
  ])("offers newer and older conversations only where the list continues on $name", ({
    offset,
    expected,
  }) => {
    const prompt = pickerPrompt(
      TARGET,
      page([listed("ask")], { offset, total: 3 }),
      NOW,
    );

    expect({
      labels: labelsOf(prompt),
      newer: prompt.answerOf(picked("Newer conversations")).kind,
      older: prompt.answerOf(picked("Older conversations")).kind,
    }).toEqual(expected);
  });

  test("keeps titles that read like its own choices apart from them", () => {
    const prompt = pickerPrompt(
      TARGET,
      page(
        [
          listed("Newer conversations"),
          listed("Older conversations"),
          listed("Search"),
        ],
        { offset: 1, total: 5 },
      ),
      NOW,
    );

    expect(labelsOf(prompt)).toEqual([
      "Newer conversations (2)",
      "Older conversations (2)",
      "Search (2)",
      "Newer conversations",
      "Older conversations",
      "Search",
    ]);
  });

  test.each<{ name: string; result: unknown }>([
    { name: "no result", result: null },
    { name: "no answers", result: { answers: {} } },
    { name: "a blank answer", result: picked("   ") },
    { name: "an answer that is no choice", result: picked("login bug") },
  ])("answers none for $name", ({ result }) => {
    const prompt = pickerPrompt(TARGET, page([listed("ask")]), NOW);

    expect(prompt.answerOf(result)).toEqual({ kind: "none" });
  });

  test("describes each conversation by when it changed, what started it, its worktree and another thread continuing it", () => {
    const prompt = pickerPrompt(
      TARGET,
      page([
        {
          ...listed("ask"),
          updatedAtMs: NOW - 3 * 60 * 60_000,
          entrypoint: "claude-desktop",
          worktree: "/w/fixture-tree",
          continued: true,
        },
      ]),
      NOW,
    );

    expect(prompt.params.questions[0]?.options[0]?.description).toBe(
      "3 h ago · Claude Desktop · worktree /w/fixture-tree · continued in another thread",
    );
  });
});

describe("searchPrompt", () => {
  test("asks for the words as free text and answers them as a search, even when they equal a listed title", () => {
    const prompt = searchPrompt(TARGET);

    expect(prompt.params.questions[0]).toMatchObject({
      isOther: true,
      options: null,
    });
    expect(prompt.answerOf(typed("  ask "))).toEqual({
      kind: "search",
      text: "ask",
    });
  });

  test.each<{ name: string; result: unknown }>([
    { name: "no result", result: null },
    { name: "a blank answer", result: typed("   ") },
  ])("answers none for $name", ({ result }) => {
    expect(searchPrompt(TARGET).answerOf(result)).toEqual({ kind: "none" });
  });
});

type PageAnswerKind = ReturnType<
  ReturnType<typeof pickerPrompt>["answerOf"]
>["kind"];

const page = (
  conversations: ListedConversation[],
  {
    offset = 0,
    total = offset + conversations.length,
  }: { offset?: number; total?: number } = {},
): PickerPage => ({
  cwd: "/w",
  maxAgeDays: 14,
  conversations,
  offset,
  total,
  search: null,
  unmatched: null,
});

const listed = (title: string): ListedConversation => ({
  title,
  updatedAtMs: NOW,
  entrypoint: "cli",
  worktree: null,
  continued: false,
});

const picked = (label: string) => ({
  answers: { conversation: { answers: [label] } },
});

const typed = (text: string) => ({
  answers: { search: { answers: [text] } },
});

const labelsOf = (prompt: ReturnType<typeof pickerPrompt>) =>
  prompt.params.questions[0]?.options.map(({ label }) => label);

const TARGET = {
  threadId: "th-1",
  turnId: "turn-1",
  itemId: "turn-1-resume-1",
};

const NOW = 1_700_000_000_000;
