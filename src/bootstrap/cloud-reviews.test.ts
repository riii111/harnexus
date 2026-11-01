import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudReviews } from "./cloud-reviews.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const review = (key: string) => ({
  key,
  reviewer: "0199-reviewer",
  verdict: "LGTM",
  taskId: "harnexus-1",
  head: "abc1234def",
  answer: "判定: LGTM",
});

// The app's answers to the calls the bridge makes for the parent chat, in order.
const setup = async (answers: Record<string, unknown>[]) => {
  const root = await mkdtemp(join(tmpdir(), "harnexus-reviews-"));
  roots.push(root);
  const calls: { tool: string; arguments: Record<string, unknown> }[] = [];
  const reviews = createCloudReviews(join(root, "reviews"), async (line) => {
    const call = JSON.parse(line);
    calls.push({ tool: call.tool, arguments: call.arguments });
    return JSON.stringify(answers.shift() ?? { outcome: "unknown" });
  });
  return { reviews, calls, root };
};

const projects = {
  outcome: "done",
  result: {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          projects: [{ projectId: "harnexus", path: "/work/harnexus" }],
        }),
      },
    ],
  },
};

describe("createCloudReviews", () => {
  test("opens a chat for a reviewer's first review, then sends its later reviews there", async () => {
    const { reviews, calls } = await setup([
      projects,
      { outcome: "done", threadId: "review-chat" },
      { outcome: "done" },
    ]);

    const first = await reviews.openReview(
      "parent",
      "/work/harnexus",
      review("t1"),
    );
    const second = await reviews.openReview(
      "parent",
      "/work/harnexus",
      review("t2"),
    );

    expect([first, second]).toEqual(["done", "done"]);
    expect(calls).toEqual([
      { tool: "list_projects", arguments: {} },
      {
        tool: "create_thread",
        arguments: {
          prompt: "/cloud-review t1",
          target: {
            type: "project",
            projectId: "harnexus",
            environment: { type: "local" },
          },
          title: "Review｜harnexus-1",
          model: "claude-sonnet-5-5",
        },
      },
      {
        tool: "send_message_to_thread",
        arguments: { threadId: "review-chat", prompt: "/cloud-review t2" },
      },
    ]);
    expect(await reviews.reviewOf("t2")).toEqual(review("t2"));
  });

  test("opens a new chat when the app no longer takes the reviewer's chat", async () => {
    const { reviews, calls } = await setup([
      projects,
      { outcome: "done", threadId: "old-chat" },
      { outcome: "rejected", error: "no such thread" },
      projects,
      { outcome: "done", threadId: "new-chat" },
    ]);

    await reviews.openReview("parent", "/work/harnexus", review("t1"));
    const outcome = await reviews.openReview(
      "parent",
      "/work/harnexus",
      review("t2"),
    );

    expect(outcome).toBe("done");
    expect(calls.map((call) => call.tool)).toEqual([
      "list_projects",
      "create_thread",
      "send_message_to_thread",
      "list_projects",
      "create_thread",
    ]);
  });

  test("names no review it never kept", async () => {
    const { reviews } = await setup([]);

    expect(await reviews.reviewOf("t9")).toBeNull();
  });
});
