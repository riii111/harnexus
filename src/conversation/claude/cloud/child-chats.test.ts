import { describe, expect, test } from "bun:test";

import { childChatName, openCloudChild } from "./child-chats.ts";

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

describe("childChatName", () => {
  test.each([
    {
      title: "Harnexus vs T3 Code 調査 [riii111/harnexus#t3-code]",
      expected: "☁️ Impl｜Harnexus vs T3 Code 調査",
    },
    { title: "[riii111/harnexus#t3-code]", expected: "☁️ Impl t3-code" },
    { title: "worker", expected: "☁️ worker" },
  ])("names a session titled $title", ({ title, expected }) => {
    expect(
      childChatName({ sessionId: "session_01NfjPqs5GNSgknfAaJ3mdYA", title }),
    ).toBe(expected);
  });
});
