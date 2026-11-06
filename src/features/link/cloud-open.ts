import type { Result } from "better-result";

import { parseCloudSessionId } from "../../infra/claude/cloud.ts";
import type { CloudLinkReservations } from "../../infra/cloud-links.ts";
import { projectOf, projectsIn } from "../../infra/codex/projects.ts";
import { isObject } from "../../lib/object.ts";

// The part of a call answer this operation reads; the rest is passed on as it is.
type Answer = { outcome: string; [key: string]: unknown };

export type CloudOpenArgs = {
  link?: unknown;
  prompt?: unknown;
  projectId?: unknown;
  cwd?: unknown;
  title?: unknown;
  model?: unknown;
  thinking?: unknown;
};

type Started = { sessionId: string; title: string | null };

export type StartCloud = (
  prompt: string,
  cwd: string,
) => Promise<Result<Started, { message: string; mayHaveStarted: boolean }>>;

// Runs the start under the caller's write rules, or answers why it was not run.
export type GuardStart = (
  caller: string,
  start: () => ReturnType<StartCloud>,
) => Promise<{ ran: Awaited<ReturnType<StartCloud>> } | { refused: Answer }>;

// Opens a chat that shows a Cloud session: a new Claude chat whose first message, /cloud, links it as if the user had typed it; a prompt first starts the session in the project's folder.
export const createCloudOpen = ({
  call,
  cloudOwner,
  reservations,
  startCloud,
  guardStart,
}: {
  // Runs a call socket tool for the caller, so the chat is created with the same checks as any create_thread.
  call: (
    caller: string,
    tool: "list_projects" | "create_thread",
    args: Record<string, unknown>,
  ) => Promise<Answer>;
  cloudOwner: (cloudSessionId: string) => string | undefined;
  // One chat per session, kept across restarts, so a chat that takes its own /cloud as a request cannot open chats without end.
  reservations: CloudLinkReservations;
  startCloud?: StartCloud;
  guardStart: GuardStart;
}) => {
  const projectWhere = async (
    caller: string,
    named: string | null,
    cwd: string | null,
  ): Promise<
    { found: { projectId: string; folder: string | null } } | { failed: Answer }
  > => {
    const listed = await call(caller, "list_projects", {});
    if (listed.outcome !== "done")
      return { failed: notSent(`list_projects failed: ${messageOf(listed)}`) };
    const projectId =
      named ?? (cwd === null ? null : await projectOf(listed.result, cwd));
    if (projectId === null)
      return {
        failed: {
          outcome: "invalid",
          message:
            cwd === null
              ? "name a projectId or the cwd of a project"
              : `no project in the app holds ${cwd}; name one with projectId`,
        },
      };
    for (const project of projectsIn(listed.result)) {
      if (isObject(project) && project.projectId === projectId)
        return {
          found: {
            projectId,
            folder: typeof project.path === "string" ? project.path : null,
          },
        };
    }

    return {
      failed: {
        outcome: "invalid",
        message: `no project ${projectId} in the app`,
      },
    };
  };

  return async (caller: string, args: CloudOpenArgs): Promise<Answer> => {
    const checked = checkArgs(args);
    if ("outcome" in checked) return checked;
    let sessionId =
      checked.link === null ? null : parseCloudSessionId(checked.link);
    if (checked.link !== null && sessionId === null)
      return {
        outcome: "invalid",
        message: "link must be a Cloud session id or its claude.ai/code URL",
      };
    let title = checked.title;
    let projectId = checked.projectId;
    if (checked.prompt !== null) {
      if (startCloud === undefined)
        return notSent("Cloud sessions are not set up for this bridge");
      const where = await projectWhere(caller, projectId, checked.cwd);
      if ("failed" in where) return where.failed;
      const { folder } = where.found;
      if (folder === null)
        return notSent(`project ${where.found.projectId} has no folder`);
      projectId = where.found.projectId;
      const prompt = checked.prompt;
      const guarded = await guardStart(caller, () =>
        startCloud(prompt, folder),
      );
      if ("refused" in guarded) return guarded.refused;
      const started = guarded.ran;
      // claude --cloud may have started a session before it failed, so starting again could make a second one.
      if (started.isErr())
        return {
          outcome: started.error.mayHaveStarted ? "unknown" : "not_sent",
          message: `claude --cloud did not report a session: ${started.error.message}`,
        };
      sessionId = started.value.sessionId;
      title ??= started.value.title;
    }

    if (sessionId === null) return { outcome: "invalid", message: ONE_OF };
    const startedHere = checked.prompt !== null;
    const session = {
      cloudSessionId: sessionId,
      url: `https://claude.ai/code/${sessionId}`,
    };
    // A session already linked, such as by a /cloud typed in a chat, keeps its chat.
    const owner = cloudOwner(sessionId);
    if (owner !== undefined)
      return {
        outcome: "done",
        result: { threadId: owner, ...session, alreadyLinked: true },
      };
    // Reserved before the app is asked, so two calls for one session cannot both open a chat.
    const reserved = await reservations.reserve(sessionId);
    if (reserved === null)
      return notOpened(
        notSent("the Cloud chat reservations cannot be read or written"),
        session,
        startedHere,
      );
    if (!reserved.reserved)
      return {
        outcome: "rejected",
        message:
          reserved.threadId === null
            ? `a chat for Cloud session ${sessionId} is being opened, or its opening did not report back; check the app, and if no chat shows the session, send /cloud ${sessionId} in a new Claude chat`
            : `a chat for Cloud session ${sessionId} was already opened (threadId ${reserved.threadId}); use that chat`,
        ...session,
      };
    if (projectId === null) {
      const where = await projectWhere(caller, null, checked.cwd);
      if ("failed" in where) {
        await reservations.release(sessionId);
        return notOpened(where.failed, session, startedHere);
      }

      projectId = where.found.projectId;
    }

    const answer = await call(caller, "create_thread", {
      prompt: `/cloud ${sessionId}`,
      target: { type: "project", projectId, environment: { type: "local" } },
      title: `${CLOUD_MARK} ${title ?? sessionId}`,
      model: checked.model ?? DEFAULT_MODEL,
      thinking: checked.thinking ?? DEFAULT_THINKING,
    });
    const threadId = answer.threadId;
    if (answer.outcome === "done" && typeof threadId === "string") {
      // A confirmation that is not written leaves the reservation without its chat, which is never opened again either way.
      await reservations.confirm(sessionId, threadId);
      return {
        outcome: "done",
        result: { threadId, ...session },
        model: answer.model,
        effort: answer.effort,
      };
    }

    // Only a call the app surely did not act on frees the session for another try; a session already started keeps running, so it is named either way.
    if (UNOPENED.has(answer.outcome)) await reservations.release(sessionId);
    return notOpened(answer, session, startedHere);
  };
};

// A session this call started stays running when its chat is surely not opened, so the caller is told to open one for it with link rather than to send the prompt again.
const notOpened = (
  answer: Answer,
  session: { cloudSessionId: string; url: string },
  startedHere: boolean,
): Answer =>
  startedHere && UNOPENED.has(answer.outcome)
    ? {
        ...answer,
        outcome: "chat_not_opened",
        chatOutcome: answer.outcome,
        message: `Cloud session ${session.cloudSessionId} was started, but its chat was not opened (${answer.outcome}: ${typeof answer.message === "string" ? answer.message : "no message"}); open it with link ${session.cloudSessionId} instead of starting another`,
        ...session,
      }
    : { ...answer, ...session };

const UNOPENED = new Set(["not_sent", "rejected", "invalid"]);

const ONE_OF = "cloud_open expects exactly one of link and prompt";

const CLOUD_MARK = "☁️";
const DEFAULT_MODEL = "claude-sonnet-5-5";
const DEFAULT_THINKING = "high";

const notSent = (message: string): Answer => ({ outcome: "not_sent", message });

const messageOf = (answer: Answer) =>
  typeof answer.message === "string" ? answer.message : answer.outcome;

type Checked = {
  link: string | null;
  prompt: string | null;
  projectId: string | null;
  cwd: string | null;
  title: string | null;
  model: string | null;
  thinking: string | null;
};

const checkArgs = (args: CloudOpenArgs): Checked | Answer => {
  const fields = [
    "link",
    "prompt",
    "projectId",
    "cwd",
    "title",
    "model",
    "thinking",
  ] as const;
  const checked: Record<string, string | null> = {};
  for (const field of fields) {
    const value = args[field];
    if (value !== undefined && typeof value !== "string")
      return { outcome: "invalid", message: `${field} must be a string` };
    checked[field] = value === undefined || value === "" ? null : value;
  }

  const result = checked as Checked;
  if (
    (result.link === null) === (result.prompt === null) ||
    result.prompt?.trim() === ""
  )
    return { outcome: "invalid", message: ONE_OF };
  for (const field of ["projectId", "title", "model", "thinking"] as const) {
    if (/[\r\n]/.test(result[field] ?? ""))
      return { outcome: "invalid", message: `${field} must be a single line` };
  }

  if (result.cwd !== null && !result.cwd.startsWith("/"))
    return { outcome: "invalid", message: "cwd must be an absolute path" };
  return result;
};
