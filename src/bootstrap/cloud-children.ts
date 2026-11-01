import { CLOUD_MARK } from "../conversation/claude/cloud.ts";
import type { CloudChild } from "../conversation/claude/cloud-children.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import { projectOf } from "../task/session.ts";

type Call = (line: string) => Promise<string>;

// Opens a chat for a session a linked Cloud session started, in the parent chat's project with /cloud as its first message, as if the parent had created it.
export const openCloudChild = async (
  call: Call,
  parentThreadId: string,
  parentFolder: string,
  child: CloudChild,
) => {
  const listed = await answerOf(call, parentThreadId, "list_projects", {});
  if (listed.outcome !== "done") return "no_project";
  const projectId = await projectOf(listed.result, parentFolder);
  if (projectId === null) return "no_project";
  const created = await answerOf(call, parentThreadId, "create_thread", {
    prompt: `/cloud ${child.sessionId}`,
    target: { type: "project", projectId, environment: { type: "local" } },
    title: childChatName(child),
    model: CLOUD_CHAT_MODEL,
  });
  return typeof created.outcome === "string" ? created.outcome : "unknown";
};

// A worker the task skills started is named as a local worker's chat is, after the mark: its session is titled "<displayName> [<owner>/<repo>#<taskId>]".
export const childChatName = (child: CloudChild) => {
  const title = child.title ?? child.sessionId;
  const task = TASK_TITLE.exec(title);
  if (task === null) return `${CLOUD_MARK} ${title}`;
  const name = task[1]?.trim() ?? "";
  return name === ""
    ? `${CLOUD_MARK} Impl ${task[2]}`
    : `${CLOUD_MARK} Impl｜${name}`;
};

const TASK_TITLE = /^(.*?)\s*\[[^\]#]+#([^\]]+)\]$/;

const answerOf = async (
  call: Call,
  threadId: string,
  tool: string,
  args: object,
): Promise<{ outcome?: unknown; result?: unknown }> => {
  const parsed = parseJson(
    await call(JSON.stringify({ threadId, tool, arguments: args })),
  );
  return parsed.isOk() && isObject(parsed.value) ? parsed.value : {};
};

const CLOUD_CHAT_MODEL = "claude-sonnet-5-5";
