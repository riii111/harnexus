import { basename } from "node:path";

import { realPathOrSelf } from "../../lib/fs.boundary.ts";
import { parseJson } from "../../lib/json.boundary.ts";
import { isObject } from "../../lib/object.ts";

export const projectsIn = (result: unknown): unknown[] => {
  if (!isObject(result)) return [];
  const texts = Array.isArray(result.content)
    ? result.content.flatMap((item) =>
        isObject(item) && item.type === "text" && typeof item.text === "string"
          ? [parseJson(item.text).unwrapOr(null)]
          : [],
      )
    : [];
  for (const listed of [result.structuredContent, result, ...texts])
    if (isObject(listed) && Array.isArray(listed.projects))
      return listed.projects;
  return [];
};

// The project whose folder holds the folder, the deepest when several do.
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
  // A chat in a worktree of its own sits outside every project, so it takes the one project of the same folder name.
  const named = projects.filter(
    ({ path }) => basename(path) === basename(real),
  );
  return named.length === 1 ? (named[0]?.projectId ?? null) : null;
};
