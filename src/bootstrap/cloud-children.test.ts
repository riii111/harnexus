import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCloudChild, projectOf } from "./cloud-children.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const listed = (...projects: { projectId: string; path: string }[]) => ({
  content: [{ type: "text", text: JSON.stringify({ projects }) }],
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

describe("openCloudChild", () => {
  test("opens a Claude chat in the parent's project whose first message links the session", async () => {
    const calls: unknown[] = [];
    const call = async (line: string) => {
      const parsed = JSON.parse(line);
      calls.push(parsed);
      return JSON.stringify(
        parsed.tool === "list_projects"
          ? {
              outcome: "done",
              result: listed({
                projectId: "p",
                path: "/Users/me/src/harnexus",
              }),
            }
          : { outcome: "done", threadId: "child-chat" },
      );
    };

    const outcome = await openCloudChild(
      call,
      "parent",
      "/Users/me/src/harnexus",
      {
        sessionId: "session_01NfjPqs5GNSgknfAaJ3mdYA",
        title: "worker",
      },
    );

    expect(outcome).toBe("done");
    expect(calls[1]).toEqual({
      threadId: "parent",
      tool: "create_thread",
      arguments: {
        prompt: "/cloud session_01NfjPqs5GNSgknfAaJ3mdYA",
        target: {
          type: "project",
          projectId: "p",
          environment: { type: "local" },
        },
        title: "☁️ worker",
        model: "claude-sonnet-5-5",
      },
    });
  });

  test("sends nothing when no project fits", async () => {
    const calls: string[] = [];
    const outcome = await openCloudChild(
      async (line) => {
        calls.push(line);
        return JSON.stringify({ outcome: "done", result: listed() });
      },
      "parent",
      "/nowhere",
      { sessionId: "session_01NfjPqs5GNSgknfAaJ3mdYA", title: null },
    );

    expect(outcome).toBe("no_project");
    expect(calls).toHaveLength(1);
  });
});
