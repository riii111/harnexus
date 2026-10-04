import { describe, expect, test } from "bun:test";
import {
  type ListedConversation,
  type PickerPage,
  pickerPrompt,
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
    ]);
    expect(prompt.answerOf(answer("same ask (2)"))).toEqual({
      kind: "picked",
      index: 1,
    });
  });

  test("offers older conversations as its own choice only while the list continues past the page", () => {
    const continued = pickerPrompt(
      TARGET,
      page([listed("ask")], { total: 3 }),
      NOW,
    );
    const last = pickerPrompt(
      TARGET,
      page([listed("ask")], { offset: 2, total: 3 }),
      NOW,
    );

    expect(labelsOf(continued)).toEqual(["ask", "Older conversations"]);
    expect(continued.answerOf(answer("Older conversations"))).toEqual({
      kind: "older",
    });
    expect(labelsOf(last)).toEqual(["ask"]);
    expect(last.answerOf(answer("Older conversations"))).toEqual({
      kind: "search",
      text: "Older conversations",
    });
  });

  test("keeps a title that reads like older conversations apart from that choice", () => {
    const prompt = pickerPrompt(
      TARGET,
      page([listed("Older conversations")], { total: 2 }),
      NOW,
    );

    expect(labelsOf(prompt)).toEqual([
      "Older conversations (2)",
      "Older conversations",
    ]);
  });

  test("answers typed text that is no label as a search", () => {
    const prompt = pickerPrompt(TARGET, page([listed("ask")]), NOW);

    expect(prompt.answerOf(answer("  login bug "))).toEqual({
      kind: "search",
      text: "login bug",
    });
  });

  test.each<{ name: string; result: unknown }>([
    { name: "no result", result: null },
    { name: "no answers", result: { answers: {} } },
    { name: "a blank answer", result: answer("   ") },
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

const answer = (typed: string) => ({
  answers: { conversation: { answers: [typed] } },
});

const labelsOf = (prompt: ReturnType<typeof pickerPrompt>) =>
  prompt.params.questions[0]?.options.map(({ label }) => label);

const TARGET = {
  threadId: "th-1",
  turnId: "turn-1",
  itemId: "turn-1-resume-1",
};

const NOW = 1_700_000_000_000;
