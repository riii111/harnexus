import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { createCallGateway } from "./call-gateway.ts";
import type { ServerRequest } from "./server-requests.ts";

describe("createCallGateway", () => {
  test("sends a Codex thread's call to the app as given and returns the answer", async () => {
    const { gateway, requests } = setup({
      answer: () => Result.ok({ content: [{ type: "text", text: "made" }] }),
    });

    const answer = await gateway.handle(
      JSON.stringify({
        threadId: CODEX,
        tool: "create_thread",
        arguments: { prompt: "review", model: "gpt-x", thinking: "medium" },
      }),
    );

    expect(JSON.parse(answer)).toEqual({
      outcome: "done",
      result: { content: [{ type: "text", text: "made" }] },
    });
    expect(requests).toEqual([
      {
        method: "mcpServer/tool/call",
        params: {
          threadId: CODEX,
          server: "codex_app",
          tool: "create_thread",
          arguments: { prompt: "review", model: "gpt-x", thinking: "medium" },
        },
        timeoutMs: 120_000,
      },
    ]);
  });

  test("waits on threads a little longer than the wait it asks for", async () => {
    const { gateway, requests } = setup();

    await gateway.handle(
      JSON.stringify({
        threadId: CODEX,
        tool: "wait_threads",
        arguments: { targets: [{ threadId: "t" }], timeoutMs: 1000 },
      }),
    );

    expect(requests.map((request) => request.timeoutMs)).toEqual([31_000]);
  });

  test("reports an answer the app marks as an error as a tool error", async () => {
    const { gateway } = setup({
      answer: () => Result.ok({ content: [], isError: true }),
    });

    const answer = await gateway.handle(
      JSON.stringify({ threadId: CODEX, tool: "list_projects" }),
    );

    expect(JSON.parse(answer).outcome).toBe("tool_error");
  });

  test.each([
    { name: "never sent", tag: "ServerRequestNotSent", outcome: "not_sent" },
    { name: "unanswered", tag: "ServerRequestUnanswered", outcome: "unknown" },
    { name: "rejected", tag: "ServerRequestRejected", outcome: "rejected" },
  ])("tells the caller a call $name", async ({ tag, outcome }) => {
    const { gateway } = setup({
      answer: () => Result.err({ _tag: tag, message: "failed" }),
    });

    const answer = await gateway.handle(
      JSON.stringify({ threadId: CODEX, tool: "create_thread", arguments: {} }),
    );

    expect(JSON.parse(answer)).toEqual({ outcome, message: "failed" });
  });

  test("sends a Claude thread's calls through one link of that thread", async () => {
    const { gateway, requests, linkCalls, opened } = setup({
      claude: [CLAUDE],
    });

    const first = await gateway.handle(
      JSON.stringify({
        threadId: CLAUDE,
        tool: "create_thread",
        arguments: { prompt: "review" },
      }),
    );
    await gateway.handle(
      JSON.stringify({
        threadId: CLAUDE,
        tool: "send_message_to_thread",
        arguments: { threadId: "r", prompt: "again" },
      }),
    );

    expect(JSON.parse(first)).toEqual({
      outcome: "done",
      result: { content: [{ type: "text", text: "linked create_thread" }] },
    });
    expect(opened).toEqual([CLAUDE]);
    expect(linkCalls).toEqual([
      { tool: "create_thread", args: { prompt: "review" } },
      {
        tool: "send_message_to_thread",
        args: { threadId: "r", prompt: "again" },
      },
    ]);
    expect(requests).toEqual([]);
  });

  test.each([
    { name: "text that is not JSON", line: "create" },
    {
      name: "a tool the app does not offer",
      line: '{"threadId":"t","tool":"delete_thread"}',
    },
    { name: "a missing thread", line: '{"tool":"list_projects"}' },
    {
      name: "an unknown field",
      line: '{"threadId":"t","tool":"list_projects","model":"x"}',
    },
  ])("refuses $name without calling the app", async ({ line }) => {
    const { gateway, requests } = setup();

    const answer = await gateway.handle(line);

    expect(JSON.parse(answer).outcome).toBe("invalid");
    expect(requests).toEqual([]);
  });
});

const setup = ({
  answer = () => Result.ok({ content: [] }),
  claude = [],
}: {
  // The real errors are told apart by their tag alone.
  answer?: () => Result<unknown, { _tag: string; message: string }>;
  claude?: readonly string[];
} = {}) => {
  const requests: { method: string; params: unknown; timeoutMs: number }[] = [];
  const linkCalls: { tool: string; args: unknown }[] = [];
  const opened: string[] = [];
  const request = (async (method, params, { timeoutMs }) => {
    requests.push({ method, params, timeoutMs });
    return answer();
  }) as ServerRequest;
  const gateway = createCallGateway({
    isClaudeThread: (threadId) => claude.includes(threadId),
    openLink: (threadId) => {
      opened.push(threadId);
      return {
        call: async (tool, args) => {
          linkCalls.push({ tool, args });
          return { content: [{ type: "text", text: `linked ${tool}` }] };
        },
      };
    },
    request,
  });
  return { gateway, requests, linkCalls, opened };
};

const CODEX = "codex-thread";
const CLAUDE = "claude-thread";
