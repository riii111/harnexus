import { describe, expect, test } from "bun:test";
import {
  prompt,
  reply,
  toolResult,
  toolUse,
} from "../../presentation/testing/session-record.ts";
import { reviewsIn } from "./cloud-reviews.ts";

const output = (fields: Record<string, unknown>) =>
  JSON.stringify(
    {
      status: "completed",
      verdict: "LGTM",
      taskId: "harnexus-1",
      base: "b1",
      head: "abc1234def",
      reviewer: "0199-reviewer",
      answer: "判定: LGTM",
      state: "/tmp/state.json",
      ...fields,
    },
    null,
    1,
  );

const ran = (id: string, content: string, isError = false) => [
  reply(`a-${id}`, `m-${id}`, toolUse(id, "Bash", {}), "tool_use"),
  toolResult(`u-${id}`, id, content, isError),
];

describe("reviewsIn", () => {
  test("reads a review harnexus-task printed, with what came around it", () => {
    const records = [
      prompt("p1", "review it"),
      ...ran("t1", `exit=0\n${output({})}\n`),
    ];

    expect(reviewsIn(records)).toEqual([
      {
        key: expect.stringMatching(/^[0-9a-f]{32}$/),
        reviewer: "0199-reviewer",
        verdict: "LGTM",
        taskId: "harnexus-1",
        head: "abc1234def",
        answer: "判定: LGTM",
      },
    ]);
  });

  test("reads a review from a file read with line numbers", () => {
    const numbered = output({
      verdict: "修正必要",
      answer: "判定: 修正必要\n\n- B1",
    })
      .split("\n")
      .map((line, index) => `${String(index + 1).padStart(6)}\t${line}`)
      .join("\n");

    const [review] = reviewsIn(ran("t1", numbered));

    expect(review?.verdict).toBe("修正必要");
    expect(review?.answer).toBe("判定: 修正必要\n\n- B1");
  });

  test.each([
    { name: "a failed tool call", content: output({}), isError: true },
    {
      name: "a review that did not finish",
      content: output({ status: "failed" }),
      isError: false,
    },
    {
      name: "an answer left empty",
      content: output({ answer: " " }),
      isError: false,
    },
    {
      name: "text that only mentions a reviewer",
      content: 'the "reviewer" said {so}',
      isError: false,
    },
  ])("ignores $name", ({ content, isError }) => {
    expect(reviewsIn(ran("t1", content, isError))).toEqual([]);
  });

  test("takes only the reviews read at or after the given record", () => {
    const records = [
      ...ran("t1", output({})),
      ...ran("t2", output({ head: "fff0000" })),
    ];

    expect(reviewsIn(records, 2).map((review) => review.head)).toEqual([
      "fff0000",
    ]);
  });

  test("takes a review read twice once, and tells reviews of different heads apart", () => {
    const records = [
      ...ran("t1", output({})),
      ...ran("t2", output({})),
      ...ran("t3", output({ head: "fff0000" })),
    ];

    expect(reviewsIn(records).map((review) => review.head)).toEqual([
      "abc1234def",
      "fff0000",
    ]);
  });
});
