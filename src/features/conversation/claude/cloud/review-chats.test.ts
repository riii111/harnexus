import {
  afterEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { Result } from "better-result";

import * as files from "../../../../lib/fs.boundary.ts";
import { createCloudReviews } from "./review-chats.ts";

const roots: string[] = [];
afterEach(async () => {
  setSystemTime();
  for (const root of roots.splice(0)) {
    await chmod(join(root, "reviews"), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

const review = (key: string) => ({
  key,
  reviewer: "0199-reviewer",
  verdict: "LGTM",
  taskId: "harnexus-1",
  head: "abc1234def",
  answer: "判定: LGTM",
});

// The app's answers to the calls the bridge makes for the parent chat, in order; a bridge started with the root of another shares its reviews folder.
const setup = async (
  answers: Record<string, unknown>[],
  options: { root?: string; during?: (tool: string) => Promise<void> } = {},
) => {
  const root =
    options.root ?? (await mkdtemp(join(tmpdir(), "harnexus-reviews-")));
  if (options.root === undefined) roots.push(root);
  const calls: { tool: string; arguments: Record<string, unknown> }[] = [];
  const reviews = createCloudReviews(join(root, "reviews"), async (line) => {
    const call = JSON.parse(line);
    calls.push({ tool: call.tool, arguments: call.arguments });
    await options.during?.(call.tool);
    return JSON.stringify(answers.shift() ?? { outcome: "unknown" });
  });
  return { reviews, calls, root, folder: join(root, "reviews") };
};

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const sentCount = (
  calls: { arguments: Record<string, unknown> }[],
  key: string,
) =>
  calls.filter((call) => call.arguments.prompt === `/cloud-review ${key}`)
    .length;

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

// Where a review goes: a chat of the reviewer's that exists, or one the first review opens.
const DELIVERIES = [
  {
    name: "an existing chat",
    held: "send_message_to_thread",
    answers: [
      projects,
      { outcome: "done", threadId: "review-chat" },
      { outcome: "done" },
    ],
    earlier: true,
  },
  {
    name: "a new chat",
    held: "create_thread",
    answers: [projects, { outcome: "done", threadId: "review-chat" }],
    earlier: false,
  },
];

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
          title: "☁️ Review｜harnexus-1",
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
      {
        outcome: "tool_error",
        result: {
          content: [{ type: "text", text: "thread not found" }],
          isError: true,
        },
      },
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

  test.each([
    {
      name: "was not sent, and tries it again later",
      text: "the connection to the server is closed, so send_message_to_thread was not sent",
      outcome: "not_sent",
      shown: false,
    },
    {
      name: "may have been sent, and keeps it as shown",
      text: "timed out. The send_message_to_thread call may or may not have taken effect and will not be repeated; ask the user to check the app.",
      outcome: "unknown",
      shown: true,
    },
    {
      name: "is blocked by an earlier unknown send",
      text: "An earlier create_thread call has an unknown outcome and is never repeated automatically.",
      outcome: "blocked",
      shown: false,
    },
  ])(
    "keeps the reviewer's chat when a send $name",
    async ({ text, outcome, shown }) => {
      const { reviews, calls } = await setup([
        projects,
        { outcome: "done", threadId: "review-chat" },
        {
          outcome: "tool_error",
          result: { content: [{ type: "text", text }], isError: true },
        },
      ]);

      await reviews.openReview("parent", "/work/harnexus", review("t1"));
      const sent = await reviews.openReview(
        "parent",
        "/work/harnexus",
        review("t2"),
      );

      expect(sent).toBe(outcome);
      expect(calls).toHaveLength(3);
      expect((await reviews.recordsOf("review-chat"))?.length).toBe(
        shown ? 4 : 2,
      );
    },
  );

  test("keeps a chat the app made whose first turn did not go as asked", async () => {
    const { reviews, calls } = await setup([
      projects,
      { outcome: "model_mismatch", threadId: "review-chat" },
      { outcome: "done" },
    ]);

    await reviews.openReview("parent", "/work/harnexus", review("t1"));
    await reviews.openReview("parent", "/work/harnexus", review("t2"));

    expect(calls.at(-1)).toEqual({
      tool: "send_message_to_thread",
      arguments: { threadId: "review-chat", prompt: "/cloud-review t2" },
    });
  });

  test("does not send a review it already sent again", async () => {
    const { reviews, calls } = await setup([
      projects,
      { outcome: "done", threadId: "review-chat" },
    ]);

    await reviews.openReview("parent", "/work/harnexus", review("t1"));
    const again = await reviews.openReview(
      "parent",
      "/work/harnexus",
      review("t1"),
    );

    expect(again).toBe("done");
    expect(calls).toHaveLength(2);
  });

  test("keeps the reviews a chat showed, oldest first, as the records of its history", async () => {
    const { reviews } = await setup([
      projects,
      { outcome: "done", threadId: "review-chat" },
      { outcome: "done" },
    ]);

    await reviews.openReview("parent", "/work/harnexus", review("t1"));
    await reviews.openReview("parent", "/work/harnexus", {
      ...review("t2"),
      answer: "判定: 修正必要",
    });
    const records = await reviews.recordsOf("review-chat");

    expect(records?.map((record) => record.type)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(records?.[3])).toContain("判定: 修正必要");
    expect(await reviews.recordsOf("other-chat")).toBeNull();
  });

  test("knows the reviewer a chat shows and the session that ran it, and keeps what was asked there after the review shown in the same millisecond", async () => {
    setSystemTime(new Date("2026-11-03T00:00:00.000Z"));
    const { reviews } = await setup([
      projects,
      { outcome: "done", threadId: "review-chat" },
    ]);
    await reviews.openReview(
      "parent",
      "/work/harnexus",
      review("t1"),
      "session_01Worker",
    );

    await reviews.noteAsk("review-chat", "B1 は既存の挙動では？");
    const records = await reviews.recordsOf("review-chat");

    expect(await reviews.chatOf("review-chat")).toEqual({
      reviewer: "0199-reviewer",
      session: "session_01Worker",
    });
    expect(await reviews.chatOf("other-chat")).toBeNull();
    expect(records?.map((record) => record.type)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(records?.[2])).toContain("B1 は既存の挙動では？");
  });

  test("opens the chat in the empty review project when there is one, as a reviewer in the app runs", async () => {
    const { reviews, calls } = await setup([
      {
        outcome: "done",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                projects: [
                  { projectId: "harnexus", path: "/work/harnexus" },
                  {
                    projectId: "review-home",
                    path: join(homedir(), "review-home"),
                  },
                ],
              }),
            },
          ],
        },
      },
      { outcome: "done", threadId: "review-chat" },
    ]);

    await reviews.openReview("parent", "/work/harnexus", review("t1"));

    expect(calls[1]?.arguments).toMatchObject({
      target: { projectId: "review-home" },
    });
  });

  test("opens the chat in the worker's project when the review project is not in the app, even with the home folder as a project", async () => {
    const { reviews, calls } = await setup([
      {
        outcome: "done",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                projects: [
                  { projectId: "home", path: homedir() },
                  { projectId: "harnexus", path: "/work/harnexus" },
                ],
              }),
            },
          ],
        },
      },
      { outcome: "done", threadId: "review-chat" },
    ]);

    await reviews.openReview("parent", "/work/harnexus", review("t1"));

    expect(calls[1]?.arguments).toMatchObject({
      target: { projectId: "harnexus" },
    });
  });

  test.each(DELIVERIES)(
    "sends a review once when a second bridge reads it while the first is sending it to $name",
    async ({ held, answers, earlier }) => {
      const sending = deferred();
      const entered = deferred();
      const first = await setup([...answers], {
        during: async (tool) => {
          if (tool !== held) return;
          entered.resolve();
          await sending.promise;
        },
      });
      if (earlier)
        await first.reviews.openReview(
          "parent",
          "/work/harnexus",
          review("t0"),
        );
      const second = await setup([{ outcome: "done" }], { root: first.root });

      const delivery = first.reviews.openReview(
        "parent",
        "/work/harnexus",
        review("t1"),
      );
      await entered.promise;
      const raced = await second.reviews.openReview(
        "parent",
        "/work/harnexus",
        review("t1"),
      );
      sending.resolve();

      expect([await delivery, raced]).toEqual(["done", "reserved"]);
      expect(second.calls).toEqual([]);
      expect(sentCount(first.calls, "t1")).toBe(1);
    },
  );

  test.each(DELIVERIES)(
    "does not send a review again after a restart when its final save failed after sending it to $name",
    async ({ held, answers, earlier }) => {
      const first = await setup([...answers], {
        during: async (tool) => {
          if (tool === held) await chmod(join(first.root, "reviews"), 0o500);
        },
      });
      if (earlier)
        await first.reviews.openReview(
          "parent",
          "/work/harnexus",
          review("t0"),
        );
      const delivery = await first.reviews.openReview(
        "parent",
        "/work/harnexus",
        review("t1"),
      );
      await chmod(first.folder, 0o700);
      const restarted = await setup([{ outcome: "done" }], {
        root: first.root,
      });

      const again = await restarted.reviews.openReview(
        "parent",
        "/work/harnexus",
        review("t1"),
      );

      expect([delivery, again]).toEqual(["done", "reserved"]);
      expect(restarted.calls).toEqual([]);
      expect(await restarted.reviews.reviewOf("t1")).toEqual(review("t1"));
    },
  );

  test.each([
    {
      name: "refused before it was sent",
      chat: false,
      answers: [projects, { outcome: "not_sent" }],
      first: "not_sent",
      second: "done",
      calls: 2,
    },
    {
      name: "found no project",
      chat: false,
      answers: [{ outcome: "done", result: { content: [] } }],
      first: "no_project",
      second: "done",
      calls: 2,
    },
    {
      name: "was blocked by an earlier send of unknown result",
      chat: true,
      answers: [
        {
          outcome: "tool_error",
          result: {
            content: [
              {
                type: "text",
                text: "An earlier create_thread call has an unknown outcome and is never repeated automatically.",
              },
            ],
            isError: true,
          },
        },
      ],
      first: "blocked",
      second: "done",
      calls: 1,
    },
    {
      name: "made a chat whose first turn was refused",
      chat: false,
      answers: [
        projects,
        { outcome: "model_mismatch", threadId: "review-chat" },
      ],
      first: "model_mismatch",
      second: "reserved",
      calls: 0,
    },
  ])(
    "after a restart, tries a review whose delivery $name again only when it was certainly not sent",
    async ({ chat, answers, first, second, calls }) => {
      const earlier = await setup([...answers]);
      if (chat)
        await seed(earlier.folder, "chats.json", {
          "0199-reviewer": { threadId: "review-chat", session: null },
        });
      const initial = await earlier.reviews.openReview(
        "parent",
        "/work/harnexus",
        review("t1"),
      );
      const restarted = await setup(
        [projects, { outcome: "done", threadId: "review-chat" }],
        {
          root: earlier.root,
        },
      );

      const again = await restarted.reviews.openReview(
        "parent",
        "/work/harnexus",
        review("t1"),
      );

      expect([initial, again]).toEqual([first, second]);
      expect(restarted.calls).toHaveLength(calls);
    },
  );

  test.each([
    {
      name: "that was sent before reservations were kept",
      file: (key: string) => ({
        ...review(key),
        sent: true,
        threadId: "c",
        shownAt: "2026-11-03T00:00:00.000Z",
      }),
      outcome: "done",
      calls: 0,
    },
    {
      name: "that was not sent before reservations were kept",
      file: (key: string) => review(key),
      outcome: "done",
      calls: 2,
    },
    {
      name: "that cannot be parsed",
      file: () => "{ not json",
      outcome: "unreadable",
      calls: 0,
    },
    {
      name: "that is not an object",
      file: () => [1],
      outcome: "unreadable",
      calls: 0,
    },
  ])(
    "reads a review file $name as its sent state tells",
    async ({ file, outcome, calls }) => {
      const {
        reviews,
        folder,
        calls: made,
      } = await setup([projects, { outcome: "done", threadId: "review-chat" }]);
      await seed(folder, "t1.json", file("t1"));

      const opened = await reviews.openReview(
        "parent",
        "/work/harnexus",
        review("t1"),
      );

      expect(opened).toBe(outcome);
      expect(made).toHaveLength(calls);
    },
  );

  test("does not send a review whose file cannot be read", async () => {
    const { reviews, folder, calls } = await setup([]);
    await mkdir(join(folder, "t1.json"), { recursive: true });

    const opened = await reviews.openReview(
      "parent",
      "/work/harnexus",
      review("t1"),
    );

    expect([opened, calls]).toEqual(["unreadable", []]);
  });

  test("keeps a reservation it did not make when a review is read again", async () => {
    const { reviews, folder, calls } = await setup([]);
    await seed(folder, "t1.reserved", {
      reservedAt: "2026-11-03T00:00:00.000Z",
    });

    const opened = await reviews.openReview(
      "parent",
      "/work/harnexus",
      review("t1"),
    );

    expect([opened, calls, await readdir(folder)]).toEqual([
      "reserved",
      [],
      ["t1.reserved"],
    ]);
  });

  test("does not send a review whose reservation cannot be kept on disk, and takes it back to try again", async () => {
    const { reviews, folder, calls } = await setup([
      projects,
      { outcome: "done", threadId: "review-chat" },
    ]);
    const exclusive = spyOn(files, "writeFileExclusive").mockImplementationOnce(
      async (path) => {
        await writeFile(path, "{}");
        return Result.err(
          new files.FileSyncFailed({
            path,
            cause: null,
            message: "cannot sync",
          }),
        );
      },
    );

    const first = await reviews.openReview(
      "parent",
      "/work/harnexus",
      review("t1"),
    );
    const filesAfter = await readdir(folder);
    const second = await reviews.openReview(
      "parent",
      "/work/harnexus",
      review("t1"),
    );
    exclusive.mockRestore();

    expect([first, filesAfter, second, sentCount(calls, "t1")]).toEqual([
      "not_kept",
      [],
      "done",
      1,
    ]);
  });

  test("takes back the reservation of a review it could not save, to try again", async () => {
    const { reviews, folder, calls } = await setup([
      projects,
      { outcome: "done", threadId: "review-chat" },
    ]);
    const atomic = spyOn(files, "writeFileAtomic").mockImplementationOnce(
      async (path) =>
        Result.err(
          new files.FileWriteFailed({
            path,
            cause: null,
            message: "cannot write",
          }),
        ),
    );

    const first = await reviews.openReview(
      "parent",
      "/work/harnexus",
      review("t1"),
    );
    const filesAfter = await readdir(folder);
    const callsAfter = calls.length;
    const second = await reviews.openReview(
      "parent",
      "/work/harnexus",
      review("t1"),
    );
    atomic.mockRestore();

    expect([first, filesAfter, callsAfter, second]).toEqual([
      "not_kept",
      [],
      0,
      "done",
    ]);
  });

  test("names no review it never kept", async () => {
    const { reviews } = await setup([]);

    expect(await reviews.reviewOf("t9")).toBeNull();
  });
});

const seed = async (folder: string, name: string, value: unknown) => {
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, name),
    typeof value === "string" ? value : JSON.stringify(value),
  );
};
