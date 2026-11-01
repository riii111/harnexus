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
  if (listed.outcome !== "done") return NO_PROJECT;
  const projectId = await projectOf(listed.result, parentFolder);
  if (projectId === null) return NO_PROJECT;
  const created = await answerOf(call, parentThreadId, "create_thread", {
    prompt: `/cloud ${child.sessionId}`,
    target: { type: "project", projectId, environment: { type: "local" } },
    title: `${CLOUD_MARK} ${child.title ?? child.sessionId}`,
    model: CLOUD_CHAT_MODEL,
  });
  return {
    outcome: typeof created.outcome === "string" ? created.outcome : "unknown",
    threadId: typeof created.threadId === "string" ? created.threadId : null,
  };
};

const NO_PROJECT = { outcome: "no_project", threadId: null };

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

const CLOUD_CHAT_MODEL = "claude-sonnet-5-5";
