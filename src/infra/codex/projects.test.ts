import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectOf } from "./projects.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("projectOf", () => {
  test("takes the deepest project holding the folder, through symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnexus-projects-"));
    roots.push(root);
    await mkdir(join(root, "work/app/sub"), { recursive: true });
    await symlink(join(root, "work"), join(root, "link"));

    const found = await projectOf(
      listed(
        { projectId: "outer", path: join(root, "work") },
        { projectId: "inner", path: join(root, "link/app") },
      ),
      join(root, "work/app/sub"),
    );

    expect(found).toBe("inner");
  });

  test("takes the one project of the same name for a chat in a worktree of its own", async () => {
    expect(
      await projectOf(
        listed(
          { projectId: "harnexus", path: "/Users/me/src/harnexus" },
          { projectId: "dotfiles", path: "/Users/me/src/dotfiles" },
        ),
        "/Users/me/.codex/worktrees/ab12/harnexus",
      ),
    ).toBe("harnexus");
  });

  test("names none when no project holds the folder or shares its name", async () => {
    expect(
      await projectOf(
        listed({ projectId: "dotfiles", path: "/Users/me/src/dotfiles" }),
        "/Users/me/.codex/worktrees/ab12/harnexus",
      ),
    ).toBeNull();
  });
});

const listed = (...projects: { projectId: string; path: string }[]) => ({
  content: [{ type: "text", text: JSON.stringify({ projects }) }],
});
