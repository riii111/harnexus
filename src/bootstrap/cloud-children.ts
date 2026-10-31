import { basename } from "node:path";
import type { CloudChild } from "../conversation/claude/cloud-children.ts";
import { realPathOrSelf } from "../runtime/fs.boundary.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import { projectsIn } from "../task/session.ts";

type Call = (line: string) => Promise<string>;

// A chat for a session a linked Cloud session started is opened in the parent chat's project, as if the parent had created it, with /cloud as its first message; the answer is the app's outcome, or why nothing was sent.
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
    title: `Cloud｜${child.title ?? child.sessionId}`,
    model: CLOUD_CHAT_MODEL,
  });
  return typeof created.outcome === "string" ? created.outcome : "unknown";
};

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

// The project whose folder holds the parent chat's folder, the deepest when several do; a chat in a worktree of its own sits outside every project, so it takes the one project of the same folder name.
export const projectOf = async (result: unknown, folder: string) => {
  const real = await realPathOrSelf(folder);
  const projects: { projectId: string; path: string }[] = [];
  for (const project of projectsIn(result)) {
    if (
      isObject(project) &&
      typeof project.projectId === "string" &&
      typeof project.path === "string"
    )
      projects.push({
        projectId: project.projectId,
        path: await realPathOrSelf(project.path),
      });
  }
  const holding = projects
    .filter(({ path }) => real === path || real.startsWith(`${path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  if (holding[0] !== undefined) return holding[0].projectId;
  const named = projects.filter(
    ({ path }) => basename(path) === basename(real),
  );
  return named.length === 1 ? (named[0]?.projectId ?? null) : null;
};

const CLOUD_CHAT_MODEL = "claude-sonnet-5-5";
