import { join } from "node:path";
import type { CloudReview } from "../conversation/claude/cloud-reviews.ts";
import {
  prepareDirectory,
  readTextFileIfExists,
  writeFileAtomic,
} from "../runtime/fs.boundary.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import { createSerialQueue } from "../runtime/serial-queue.ts";
import { projectOf } from "./cloud-children.ts";

type Call = (line: string) => Promise<string>;

// Keeps the reviews a Cloud session read, one file each, and the chat each reviewer's reviews are shown in.
export const createCloudReviews = (dir: string, call: Call) => {
  const chatsPath = join(dir, "chats.json");
  const queue = createSerialQueue();

  const readJson = async (path: string) => {
    const text = await readTextFileIfExists(path);
    if (text.isErr() || text.value === null) return null;
    const parsed = parseJson(text.value);
    return parsed.isOk() && isObject(parsed.value) ? parsed.value : null;
  };

  const write = async (path: string, value: object) => {
    const made = await prepareDirectory(dir);
    if (made.isErr()) return false;
    return (await writeFileAtomic(path, JSON.stringify(value))).isOk();
  };

  const reviewOf = async (key: string): Promise<CloudReview | null> => {
    const kept = await readJson(join(dir, `${key}.json`));
    if (
      kept === null ||
      typeof kept.reviewer !== "string" ||
      typeof kept.answer !== "string"
    )
      return null;
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    return {
      key,
      reviewer: kept.reviewer,
      verdict: text(kept.verdict),
      taskId: text(kept.taskId),
      head: text(kept.head),
      answer: kept.answer,
    };
  };

  // Sends the review to its reviewer's chat, which is opened in the parent chat's project the first time; reviews go out one at a time, so the chats file is never written twice at once.
  const openReview = (
    parentThreadId: string,
    parentFolder: string,
    review: CloudReview,
  ) =>
    queue.run("reviews", async () => {
      const path = join(dir, `${review.key}.json`);
      // A review already sent, such as one a restarted bridge reads again, is not sent twice.
      if ((await readJson(path))?.sent === true) return "done";
      if (!(await write(path, review))) return "not_kept";
      const sent = await deliver(parentThreadId, parentFolder, review);
      if (sent === "done") await write(path, { ...review, sent: true });
      return sent;
    });

  const deliver = async (
    parentThreadId: string,
    parentFolder: string,
    review: CloudReview,
  ) => {
    const prompt = `/cloud-review ${review.key}`;
    const chats = (await readJson(chatsPath)) ?? {};
    const chat = chats[review.reviewer];
    if (typeof chat === "string") {
      const sent = await answerOf(
        call,
        parentThreadId,
        "send_message_to_thread",
        { threadId: chat, prompt },
      );
      // A chat the app no longer takes, such as one deleted, is replaced by a new one.
      if (!GONE.has(outcomeOf(sent))) return outcomeOf(sent);
    }
    const listed = await answerOf(call, parentThreadId, "list_projects", {});
    if (listed.outcome !== "done") return "no_project";
    const projectId = await projectOf(listed.result, parentFolder);
    if (projectId === null) return "no_project";
    const created = await answerOf(call, parentThreadId, "create_thread", {
      prompt,
      target: { type: "project", projectId, environment: { type: "local" } },
      title: `Review｜${review.taskId ?? review.reviewer}`,
      model: REVIEW_CHAT_MODEL,
    });
    if (created.outcome === "done" && typeof created.threadId === "string") {
      const latest = (await readJson(chatsPath)) ?? {};
      await write(chatsPath, {
        ...latest,
        [review.reviewer]: created.threadId,
      });
    }
    return outcomeOf(created);
  };

  return { reviewOf, openReview };
};

const answerOf = async (
  call: Call,
  threadId: string,
  tool: string,
  args: object,
): Promise<{ outcome?: unknown; result?: unknown; threadId?: unknown }> => {
  const parsed = parseJson(
    await call(JSON.stringify({ threadId, tool, arguments: args })),
  );
  return parsed.isOk() && isObject(parsed.value) ? parsed.value : {};
};

const outcomeOf = (answer: { outcome?: unknown }) =>
  typeof answer.outcome === "string" ? answer.outcome : "unknown";

const GONE = new Set(["rejected", "invalid"]);

const REVIEW_CHAT_MODEL = "claude-sonnet-5-5";
