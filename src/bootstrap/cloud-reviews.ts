import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { reviewText } from "../conversation/claude/cloud.ts";
import type { CloudReview } from "../conversation/claude/cloud-reviews.ts";
import {
  listDirectoryIfExists,
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
      // A send whose outcome is unknown may have shown the review, so it is kept as shown rather than sent again.
      if (sent.outcome === "done" || sent.outcome === "unknown")
        await write(path, {
          ...review,
          sent: true,
          threadId: sent.threadId,
          shownAt: new Date().toISOString(),
        });
      return sent.outcome;
    });

  const deliver = async (
    parentThreadId: string,
    parentFolder: string,
    review: CloudReview,
  ): Promise<{ outcome: string; threadId: string | null }> => {
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
      const outcome = sendOutcome(sent);
      // Only a chat the app itself refused, such as one deleted, is replaced by a new one.
      if (outcome !== "gone") return { outcome, threadId: chat };
    }
    const listed = await answerOf(call, parentThreadId, "list_projects", {});
    if (listed.outcome !== "done") return NO_PROJECT;
    const projectId = await projectOf(listed.result, parentFolder);
    if (projectId === null) return NO_PROJECT;
    const created = await answerOf(call, parentThreadId, "create_thread", {
      prompt,
      target: { type: "project", projectId, environment: { type: "local" } },
      title: `Review｜${review.taskId ?? review.reviewer}`,
      model: REVIEW_CHAT_MODEL,
    });
    const threadId =
      typeof created.threadId === "string" ? created.threadId : null;
    // A chat the app made is kept even when its first turn did not go as asked, so the next review does not open another.
    if (threadId !== null) {
      const latest = (await readJson(chatsPath)) ?? {};
      await write(chatsPath, { ...latest, [review.reviewer]: threadId });
    }
    return { outcome: outcomeOf(created), threadId };
  };

  // The reviews shown in a reviewer's chat as the records of a conversation, oldest first, for the chat's history.
  const recordsOf = async (threadId: string) => {
    const names = await listDirectoryIfExists(dir);
    if (names.isErr() || names.value === null) return null;
    const shown: { at: string; review: CloudReview }[] = [];
    for (const name of names.value) {
      if (!name.endsWith(".json") || name === "chats.json") continue;
      const kept = await readJson(join(dir, name));
      if (kept?.threadId !== threadId || typeof kept.shownAt !== "string")
        continue;
      const review = await reviewOf(name.slice(0, -".json".length));
      if (review !== null) shown.push({ at: kept.shownAt, review });
    }
    if (shown.length === 0) return null;
    shown.sort((a, b) => a.at.localeCompare(b.at));
    return shown.flatMap(({ at, review }) => reviewRecords(review, at));
  };

  return { reviewOf, openReview, recordsOf };
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

// A review as a prompt and the reply that shows it, in the shape Claude's own records take.
const reviewRecords = (review: CloudReview, at: string) =>
  [
    {
      type: "user",
      uuid: `review-${review.key}-asked`,
      session_id: "cloud-review",
      message: { role: "user", content: `/cloud-review ${review.key}` },
      parent_tool_use_id: null,
      timestamp: at,
    },
    {
      type: "assistant",
      uuid: `review-${review.key}-shown`,
      session_id: "cloud-review",
      message: {
        id: `review-${review.key}`,
        type: "message",
        role: "assistant",
        model: "cloud-review",
        content: [{ type: "text", text: reviewText(review) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {},
      },
      parent_tool_use_id: null,
      timestamp: at,
    },
  ] as unknown as SessionMessage[];

const outcomeOf = (answer: { outcome?: unknown }) =>
  typeof answer.outcome === "string" ? answer.outcome : "unknown";

const NO_PROJECT = { outcome: "no_project", threadId: null };

// Sent from a Claude chat, every failure answers tool_error; the bridge's own failures are told apart by their text, and any other came from the app.
const sendOutcome = (answer: { outcome?: unknown; result?: unknown }) => {
  const outcome = outcomeOf(answer);
  if (outcome !== "tool_error") return GONE.has(outcome) ? "gone" : outcome;
  const text = resultText(answer.result);
  if (UNKNOWN_SEND.test(text)) return "unknown";
  if (BLOCKED_SEND.test(text)) return "blocked";
  if (NOT_SENT.test(text)) return "not_sent";
  return "gone";
};

const resultText = (result: unknown) =>
  isObject(result) && Array.isArray(result.content)
    ? result.content
        .map((item) =>
          isObject(item) && typeof item.text === "string" ? item.text : "",
        )
        .join("\n")
    : "";

const GONE = new Set(["rejected", "invalid"]);
const UNKNOWN_SEND = /may or may not have taken effect/;
// An earlier send left unknown stops every later one from the same chat, which trying again does not change.
const BLOCKED_SEND =
  /unknown outcome and is never repeated|not registered as a Claude thread/;
const NOT_SENT = /was not sent/;

const REVIEW_CHAT_MODEL = "claude-sonnet-5-5";
