import { isAbsolute, relative, sep } from "node:path";
import type { FileUpdateChange } from "./protocol.ts";

// The changes a turn made, as one unified diff in git's form, which the app shows as the turn's changes.
export const turnDiff = (changes: readonly FileUpdateChange[], cwd: string) => {
  const files = new Map<string, { added: boolean; hunks: string[] }>();
  for (const change of changes) {
    const path = pathIn(change.path, cwd);
    const file = files.get(path) ?? {
      added: change.kind.type === "add",
      hunks: [],
    };
    file.hunks.push(
      change.kind.type === "add" ? addedHunk(change.diff) : change.diff,
    );
    files.set(path, file);
  }
  return [...files.entries()]
    .map(([path, { added, hunks }]) =>
      [
        `diff --git a/${path} b/${path}\n`,
        added ? "new file mode 100644\n--- /dev/null\n" : `--- a/${path}\n`,
        `+++ b/${path}\n`,
        ...hunks,
      ].join(""),
    )
    .join("");
};

// A path in the folder is named from it; a Cloud session's path, in a checkout elsewhere, is named from the folder of the same name in it.
const pathIn = (path: string, cwd: string) => {
  const inside = relative(cwd, path);
  if (!inside.startsWith("..") && !isAbsolute(inside))
    return inside.split(sep).join("/");
  const name = cwd.split(sep).filter(Boolean).at(-1);
  const parts = path.split("/");
  const at = name === undefined ? -1 : parts.lastIndexOf(name);
  return at === -1 ? path.replace(/^\/+/, "") : parts.slice(at + 1).join("/");
};

const addedHunk = (content: string) => {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join("")}`;
};
