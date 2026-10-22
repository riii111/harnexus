import { describe, expect, test } from "bun:test";
import type { Fields } from "../format.ts";
import { answerTo, busyReason, readThread } from "./worker-thread.ts";

const answered = (read: unknown) => async () => ({
  outcome: "done",
  result: { content: [{ type: "text", text: JSON.stringify(read) }] },
});

describe("readThread", () => {
  test("reads a Codex worker's delegation from the call output, even when cut short", async () => {
    const prompt =
      "$task-worker\nPR <https://github.com/org/pay/pull/7> で対応が必要なこと";
    const calls: Fields[] = [];
    const view = await readThread(
      async (caller, tool, args) => {
        calls.push({ caller, tool, ...args });
        return answered({
          thread: { status: { type: "idle" } },
          turns: [
            {
              status: "completed",
              startedAt: 100,
              completedAt: 160,
              items: [
                {
                  type: "functionCallOutput",
                  name: "send_message_to_thread",
                  output: {
                    text: "<codex_delegation>\n  <source_thread_id>reviewer</source_thread_id>\n  <input>$task-worker\nPR &lt;https://github.com/org/pay/pull/7&gt; で対応",
                    truncated: true,
                  },
                },
                { type: "agentMessage", phase: "commentary", text: "読むのだ" },
                {
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "指摘なし",
                },
              ],
            },
          ],
        })();
      },
      "reviewer",
      "worker",
    );

    expect(calls).toEqual([
      {
        caller: "reviewer",
        tool: "read_thread",
        threadId: "worker",
        turnLimit: 5,
        includeOutputs: true,
        maxOutputCharsPerItem: 2000,
      },
    ]);
    const turns = view !== null && !view.gone ? view.turns : [];
    const turn = answerTo(turns, {
      at: new Date(100_000).toISOString(),
      sender: "reviewer",
      prompt,
    });
    expect([turn?.origin, turn?.answer]).toEqual(["delegated", "指摘なし"]);
  });

  test.each([
    {
      name: "a deleted thread as gone",
      answer: {
        outcome: "tool_error",
        result: {
          content: [
            { type: "text", text: "No Codex thread found for threadId: w" },
          ],
          isError: true,
        },
      },
      expected: { gone: true },
    },
    {
      name: "an app that cannot be reached as unknown",
      answer: { outcome: "not_sent", error: "ENOENT" },
      expected: null,
    },
  ])("reports $name", async ({ answer, expected }) => {
    const view = await readThread(async () => answer, "reviewer", "worker");

    expect(view).toEqual(expected);
  });
});

describe("busyReason", () => {
  const now = new Date(1_000_000_000);
  const at = (secondsAgo: number) => now.getTime() / 1000 - secondsAgo;
  const turn = (fields: Fields) => ({
    status: "completed",
    startedAt: at(600),
    completedAt: at(600),
    origin: "owner" as const,
    delegation: null,
    answer: "",
    ...fields,
  });

  test.each([
    {
      name: "a running thread",
      active: true,
      latest: turn({}),
      expected: "worker turn in progress",
    },
    {
      name: "a turn still in progress",
      active: false,
      latest: turn({ status: "inProgress", completedAt: null }),
      expected: "worker turn in progress",
    },
    {
      name: "the owner's turn that ended a minute ago",
      active: false,
      latest: turn({ completedAt: at(60) }),
      expected: "owner just talked to the worker",
    },
    {
      name: "the owner's turn that ended ten minutes ago",
      active: false,
      latest: turn({}),
      expected: null,
    },
    {
      name: "another thread's turn that ended a minute ago",
      active: false,
      latest: turn({ origin: "delegated", completedAt: at(60) }),
      expected: null,
    },
  ])("tells $name", ({ active, latest, expected }) => {
    expect(busyReason({ active, turns: [latest] }, now)).toBe(expected);
  });
});
