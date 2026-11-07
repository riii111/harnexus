import { describe, expect, test } from "bun:test";

import { openCloudChild } from "./child-chats.ts";

const listed = (...projects: { projectId: string; path: string }[]) => ({
  content: [{ type: "text", text: JSON.stringify({ projects }) }],
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
        sessionId: "session_01ChildFixtureSession000",
        title: "worker",
      },
    );

    expect(outcome).toBe("done");
    expect(calls[1]).toEqual({
      threadId: "parent",
      tool: "create_thread",
      arguments: {
        prompt: "/cloud session_01ChildFixtureSession000",
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
      { sessionId: "session_01ChildFixtureSession000", title: null },
    );

    expect(outcome).toBe("no_project");
    expect(calls).toHaveLength(1);
  });
});

describe("openCloudChild titles", () => {
  test.each([
    {
      title: "サンプル調査 [owner/repo#topic]",
      expected: "☁️ サンプル調査 [owner/repo#topic]",
    },
    { title: null, expected: "☁️ session_01ChildFixtureSession000" },
  ])(
    "names the chat of a session titled $title",
    async ({ title, expected }) => {
      const titles: unknown[] = [];
      await openCloudChild(
        async (line) => {
          const parsed = JSON.parse(line);
          if (parsed.tool === "create_thread")
            titles.push(parsed.arguments.title);
          return JSON.stringify({
            outcome: "done",
            result: listed({ projectId: "p", path: "/work" }),
          });
        },
        "parent",
        "/work",
        { sessionId: "session_01ChildFixtureSession000", title },
      );

      expect(titles).toEqual([expected]);
    },
  );
});
