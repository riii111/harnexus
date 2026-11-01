import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CLOUD_MARK,
  REVIEW_ASK_SENT,
  reviewText,
} from "../conversation/claude/cloud.ts";
import type { CloudReview } from "../conversation/claude/cloud-reviews.ts";
import {
  listDirectoryIfExists,
  prepareDirectory,
  readTextFileIfExists,
  realPathOrSelf,
  writeFileAtomic,
} from "../runtime/fs.boundary.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import { createSerialQueue } from "../runtime/serial-queue.ts";
import { projectOf, projectsIn } from "../task/session.ts";

type Call = (line: string) => Promise<string>;

// Keeps the reviews a Cloud session read, one file each, and the chat each reviewer's reviews are shown in.
export const createCloudReviews = (
  dir: string,
  call: Call,
  reviewHome = join(homedir(), "review-home"),
) => {
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
    workerSession: string | null = null,
  ) =>
    queue.run("reviews", async () => {
      const path = join(dir, `${review.key}.json`);
      // A review already sent, such as one a restarted bridge reads again, is not sent twice.
      if ((await readJson(path))?.sent === true) return "done";
      if (!(await write(path, review))) return "not_kept";
      const sent = await deliver(
        parentThreadId,
        parentFolder,
        review,
        workerSession,
      );
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
    workerSession: string | null,
  ): Promise<{ outcome: string; threadId: string | null }> => {
    const prompt = `/cloud-review ${review.key}`;
    const chats = (await readJson(chatsPath)) ?? {};
    const chat = chatIn(chats[review.reviewer])?.threadId ?? null;
    // The chat's messages go to the session that ran the reviewer, which is kept with the chat.
    const keep = async (threadId: string) => {
      const latest = (await readJson(chatsPath)) ?? {};
      await write(chatsPath, {
        ...latest,
        [review.reviewer]: { threadId, session: workerSession },
      });
    };
    if (chat !== null) {
      const sent = await answerOf(
        call,
        parentThreadId,
        "send_message_to_thread",
        { threadId: chat, prompt },
      );
      const outcome = sendOutcome(sent);
      // Only a chat the app itself refused, such as one deleted, is replaced by a new one.
      if (outcome !== "gone") {
        await keep(chat);
        return { outcome, threadId: chat };
      }
    }
    const listed = await answerOf(call, parentThreadId, "list_projects", {});
    if (listed.outcome !== "done") return NO_PROJECT;
    // Like a reviewer in the app, the chat opens in the empty review project when there is one, and in the worker's project otherwise.
    const projectId =
      (await projectAt(listed.result, reviewHome)) ??
      (await projectOf(listed.result, parentFolder));
    if (projectId === null) return NO_PROJECT;
    const created = await answerOf(call, parentThreadId, "create_thread", {
      prompt,
      target: { type: "project", projectId, environment: { type: "local" } },
      title: `${CLOUD_MARK} Review｜${review.taskId ?? review.reviewer}`,
      model: REVIEW_CHAT_MODEL,
    });
    const threadId =
      typeof created.threadId === "string" ? created.threadId : null;
    // A chat the app made is kept even when its first turn did not go as asked, so the next review does not open another.
    if (threadId !== null) await keep(threadId);
    return { outcome: outcomeOf(created), threadId };
  };

  // The reviewer a chat shows and the session that ran it, which the chat's messages go to.
  const chatOf = async (threadId: string) => {
    const chats = (await readJson(chatsPath)) ?? {};
    for (const [reviewer, value] of Object.entries(chats)) {
      const chat = chatIn(value);
      if (chat?.threadId === threadId)
        return { reviewer, session: chat.session };
    }
    return null;
  };

  // Keeps a message the user sent the reviewer from its chat, for the chat's history.
  const noteAsk = async (threadId: string, text: string) => {
    const at = new Date().toISOString();
    await write(join(dir, `${ASKED}${Date.now()}-${randomUUID()}.json`), {
      threadId,
      shownAt: at,
      asked: text,
    });
  };

  // The reviews shown in a reviewer's chat and the messages sent from it, as the records of a conversation, oldest first, for the chat's history.
  const recordsOf = async (threadId: string) => {
    const names = await listDirectoryIfExists(dir);
    if (names.isErr() || names.value === null) return null;
    const shown: { at: string; records: SessionMessage[] }[] = [];
    for (const name of names.value) {
      if (!name.endsWith(".json") || name === "chats.json") continue;
      const kept = await readJson(join(dir, name));
      if (kept?.threadId !== threadId || typeof kept.shownAt !== "string")
        continue;
      const at = kept.shownAt;
      if (name.startsWith(ASKED)) {
        if (typeof kept.asked === "string")
          shown.push({ at, records: askedRecords(name, kept.asked, at) });
        continue;
      }
      const review = await reviewOf(name.slice(0, -".json".length));
      if (review !== null)
        shown.push({ at, records: reviewRecords(review, at) });
    }
    if (shown.length === 0) return null;
    shown.sort((a, b) => a.at.localeCompare(b.at));
    return shown.flatMap((entry) => entry.records);
  };

  return { reviewOf, openReview, recordsOf, chatOf, noteAsk };
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

// A reviewer's chat as the chats file keeps it; a file written before the session was kept names the chat alone.
const chatIn = (
  value: unknown,
): { threadId: string; session: string | null } | null => {
  if (typeof value === "string") return { threadId: value, session: null };
  if (!isObject(value) || typeof value.threadId !== "string") return null;
  return {
    threadId: value.threadId,
    session: typeof value.session === "string" ? value.session : null,
  };
};

const ASKED = "asked-";

// A message sent from a reviewer's chat and the note that answered it, in the shape Claude's own records take.
const askedRecords = (name: string, text: string, at: string) =>
  [
    {
      type: "user",
      uuid: `${name}-asked`,
      session_id: "cloud-review",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      timestamp: at,
    },
    {
      type: "assistant",
      uuid: `${name}-sent`,
      session_id: "cloud-review",
      message: {
        id: name,
        type: "message",
        role: "assistant",
        model: "cloud-review",
        content: [{ type: "text", text: REVIEW_ASK_SENT }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {},
      },
      parent_tool_use_id: null,
      timestamp: at,
    },
  ] as unknown as SessionMessage[];

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

// The project whose folder is the folder itself, not one holding it.
const projectAt = async (result: unknown, folder: string) => {
  const real = await realPathOrSelf(folder);
  for (const project of projectsIn(result)) {
    if (
      isObject(project) &&
      typeof project.projectId === "string" &&
      typeof project.path === "string" &&
      (await realPathOrSelf(project.path)) === real
    )
      return project.projectId;
  }
  return null;
};

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
