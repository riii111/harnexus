import { describe, expect, test } from "bun:test";

import { Result } from "better-result";

import type { ServerRequest } from "../../infra/codex/server-requests.ts";
import { createCallGateway } from "./call-gateway.ts";
import type { StartCloud } from "./cloud-open.ts";
import { createDelegationWatch, type FirstTurn } from "./delegations.ts";
import { failure, type ToolResult } from "./results.ts";

describe("createCallGateway", () => {
  test("sends a Codex thread's call to the app as given and returns the answer with the new thread", async () => {
    const { gateway, requests, watch } = setup({
      answer: () => {
        watch.observe(CODEX, "th-new", { model: "gpt-x", effort: "medium" });
        return Result.ok({ content: [{ type: "text", text: "made" }] });
      },
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
      threadId: "th-new",
      model: "gpt-x",
      effort: "medium",
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

  test("loads a Codex caller the app server has unloaded and sends its call again", async () => {
    const answers = [
      Result.err({
        _tag: "ServerRequestRejected",
        message: `thread not found: ${CODEX}`,
      }),
      Result.ok({}),
      Result.ok({ content: [{ type: "text", text: "sent" }] }),
    ];
    const { gateway, requests } = setup({
      answer: () => answers.shift() ?? Result.ok({}),
    });

    const answer = await gateway.handle(
      JSON.stringify({
        threadId: CODEX,
        tool: "send_message_to_thread",
        arguments: { threadId: "worker", prompt: "hi" },
      }),
    );

    expect(JSON.parse(answer).outcome).toBe("done");
    expect(requests.map(({ method, params }) => [method, params])).toEqual([
      [
        "mcpServer/tool/call",
        {
          threadId: CODEX,
          server: "codex_app",
          tool: "send_message_to_thread",
          arguments: { threadId: "worker", prompt: "hi" },
        },
      ],
      ["thread/resume", { threadId: CODEX, excludeTurns: true }],
      [
        "mcpServer/tool/call",
        {
          threadId: CODEX,
          server: "codex_app",
          tool: "send_message_to_thread",
          arguments: { threadId: "worker", prompt: "hi" },
        },
      ],
    ]);
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
      threadId: "th-reviewer",
      model: "gpt-x",
      effort: null,
    });
    expect(opened).toEqual([CLAUDE]);
    expect(linkCalls).toEqual([
      { tool: "checked create_thread", args: { prompt: "review" } },
      {
        tool: "send_message_to_thread",
        args: { threadId: "r", prompt: "again" },
      },
    ]);
    expect(requests).toEqual([]);
  });

  test.each([
    {
      name: "a linked session",
      sessionId: "session_01Linked",
      threadId: "linked-chat",
    },
    { name: "one no chat shows", sessionId: "session_01Free", threadId: null },
  ])(
    "answers which chat shows $name, without the app",
    async ({ sessionId, threadId }) => {
      const { gateway, requests, linkCalls } = setup({ claude: [CLAUDE] });

      const answer = await gateway.handle(
        JSON.stringify({
          threadId: CLAUDE,
          tool: "cloud_chat",
          arguments: { sessionId },
        }),
      );

      expect(JSON.parse(answer)).toEqual({
        outcome: "done",
        result: { threadId },
      });
      expect([requests, linkCalls]).toEqual([[], []]);
    },
  );

  test.each([
    { kind: "Codex", threadId: CODEX },
    { kind: "Claude", threadId: CLAUDE },
  ])(
    "names the calling $kind thread through the app server",
    async ({ threadId }) => {
      const { gateway, requests, linkCalls } = setup({ claude: [CLAUDE] });

      const answer = await gateway.handle(
        JSON.stringify({
          threadId,
          tool: "name_thread",
          arguments: { name: "Impl｜決済を再送する PR#12" },
        }),
      );

      expect(JSON.parse(answer)).toEqual({
        outcome: "done",
        result: { content: [] },
      });
      expect(requests).toEqual([
        {
          method: "thread/name/set",
          params: { threadId, name: "Impl｜決済を再送する PR#12" },
          timeoutMs: 60_000,
        },
      ]);
      expect(linkCalls).toEqual([]);
    },
  );

  test.each([
    { name: "an empty", value: " " },
    { name: "a multi-line", value: "a\nb" },
    { name: "a missing", value: undefined },
  ])("refuses $name thread name without calling the app", async ({ value }) => {
    const { gateway, requests } = setup();

    const answer = await gateway.handle(
      JSON.stringify({
        threadId: CODEX,
        tool: "name_thread",
        arguments: { name: value },
      }),
    );

    expect(JSON.parse(answer).outcome).toBe("invalid");
    expect(requests).toEqual([]);
  });

  test.each([
    { name: "text that is not JSON", line: "create" },
    {
      name: "a tool the app does not offer",
      line: '{"threadId":"t","tool":"delete_thread"}',
    },
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

describe("createCallGateway create_thread of a Codex thread", () => {
  test("answers with the real id when the first turn arrives after the tool answer", async () => {
    const { gateway, watch } = setup({
      answer: () => Result.ok(CLIENT_ANSWER),
    });

    const answering = gateway.handle(CREATE);
    await Bun.sleep(5);
    expect(watch.observe(CODEX, "th-worker", ASKED)).toBe(true);

    expect(JSON.parse(await answering)).toEqual({
      outcome: "done",
      result: CLIENT_ANSWER,
      threadId: "th-worker",
      ...ASKED,
    });
  });

  test("reports a first turn the bridge refused after the settings check, with its reason", async () => {
    const { gateway, watch } = setup({
      answer: () => {
        watch.observe(CODEX, "th-worker", ASKED, true);
        watch.started("th-worker", "directory_unknown");
        return Result.ok(CLIENT_ANSWER);
      },
    });

    const answer = JSON.parse(await gateway.handle(CREATE));

    expect(answer).toEqual({
      outcome: "first_turn_refused",
      threadId: "th-worker",
      reason: "directory_unknown",
    });
  });

  test("sends a caller's next create only after the first turn of its previous one", async () => {
    const { gateway, watch, requests } = setup({
      answer: () => Result.ok(CLIENT_ANSWER),
    });

    const first = gateway.handle(CREATE);
    const second = gateway.handle(CREATE);
    await Bun.sleep(5);
    expect(requests).toHaveLength(1);
    watch.observe(CODEX, "th-worker-1", ASKED);
    expect(JSON.parse(await first).threadId).toBe("th-worker-1");
    await Bun.sleep(5);
    expect(requests).toHaveLength(2);
    watch.observe(CODEX, "th-worker-2", ASKED);

    expect(JSON.parse(await second).threadId).toBe("th-worker-2");
  });

  test("answers unknown when the first turn is late, still refuses it on another model and sends no other create meanwhile", async () => {
    const { gateway, watch, requests } = setup({
      answer: () => Result.ok(CLIENT_ANSWER),
    });

    const first = JSON.parse(await gateway.handle(CREATE));
    const second = JSON.parse(await gateway.handle(CREATE));

    expect(first).toMatchObject({ outcome: "unknown", result: CLIENT_ANSWER });
    expect(first.threadId).toBeUndefined();
    expect(second.outcome).toBe("not_sent");
    expect(requests).toHaveLength(1);
    expect(watch.observe(CODEX, "th-worker", OTHER)).toBe(false);
  });

  test("sends a create again once the check of an unconfirmed one expires", async () => {
    const { gateway, requests } = setup({
      answer: () => Result.ok(CLIENT_ANSWER),
      armedMs: 80,
    });

    await gateway.handle(CREATE);
    await Bun.sleep(60);
    await gateway.handle(CREATE);

    expect(requests).toHaveLength(2);
  });

  test.each([
    {
      name: "rejected",
      tag: "ServerRequestRejected",
      seen: ASKED,
      expected: { outcome: "done", threadId: "th-worker", ...ASKED },
    },
    {
      name: "unanswered on another model",
      tag: "ServerRequestUnanswered",
      seen: OTHER,
      expected: { outcome: "model_mismatch", threadId: "th-worker" },
    },
  ])(
    "answers from a first turn already seen when the call is $name",
    async ({ tag, seen, expected }) => {
      const { gateway, watch } = setup({
        answer: () => {
          watch.observe(CODEX, "th-worker", seen);
          return Result.err({ _tag: tag, message: "failed" });
        },
      });

      const answer = JSON.parse(await gateway.handle(CREATE));

      expect(answer).toMatchObject(expected);
    },
  );

  test("answers done for an accepted first turn even when the app answers with an error", async () => {
    const { gateway, watch } = setup({
      answer: () => {
        watch.observe(CODEX, "th-worker", ASKED);
        return Result.ok({ content: [], isError: true });
      },
    });

    const answer = JSON.parse(await gateway.handle(CREATE));

    expect(answer).toMatchObject({ outcome: "done", threadId: "th-worker" });
  });

  test("reports a refused first turn even when the app then answers with an error", async () => {
    const { gateway, watch } = setup({
      answer: () => {
        watch.observe(CODEX, "th-worker", OTHER);
        return Result.ok({ content: [], isError: true });
      },
    });

    const answer = JSON.parse(await gateway.handle(CREATE));

    expect(answer.outcome).toBe("model_mismatch");
  });

  test("answers with the id the app named and still checks that thread's late first turn", async () => {
    const { gateway, watch } = setup({
      answer: () => Result.ok(NAMED_ANSWER),
    });

    const answer = JSON.parse(await gateway.handle(CREATE));

    expect(answer).toMatchObject({ outcome: "unknown", threadId: "th-named" });
    expect(watch.observe(CODEX, "th-other", OTHER)).toBe(true);
    expect(watch.observe(CODEX, "th-named", OTHER)).toBe(false);
  });

  test("answers done with the id the app named once that thread's first turn comes", async () => {
    const { gateway, watch } = setup({
      answer: () => Result.ok(NAMED_ANSWER),
    });

    const answering = gateway.handle(CREATE);
    await Bun.sleep(5);
    watch.observe(CODEX, "th-named", ASKED);

    expect(JSON.parse(await answering)).toMatchObject({
      outcome: "done",
      threadId: "th-named",
    });
  });

  test("keeps the check of a thread an error answer named", async () => {
    const { gateway, watch } = setup({
      answer: () => Result.ok({ ...NAMED_ANSWER, isError: true }),
    });

    const answer = JSON.parse(await gateway.handle(CREATE));

    expect(answer).toMatchObject({ outcome: "unknown", threadId: "th-named" });
    expect(watch.observe(CODEX, "th-named", OTHER)).toBe(false);
  });

  test("checks nothing after the app answers with an error", async () => {
    const { gateway, watch } = setup({
      answer: () => Result.ok({ content: [], isError: true }),
    });

    const answer = JSON.parse(await gateway.handle(CREATE));

    expect(answer.outcome).toBe("tool_error");
    expect(watch.observe(CODEX, "th-other", OTHER)).toBe(true);
  });
});

describe("createCallGateway create_thread of a Claude thread", () => {
  test("answers not_sent when the link sent nothing for an unconfirmed earlier create", async () => {
    const { gateway } = setup({
      claude: [CLAUDE],
      created: { firstTurn: null, threadId: null, unknown: false, busy: true },
    });

    const answer = await gateway.handle(
      JSON.stringify({
        threadId: CLAUDE,
        tool: "create_thread",
        arguments: { prompt: "review" },
      }),
    );

    expect(JSON.parse(answer).outcome).toBe("not_sent");
  });

  test.each([
    {
      name: "a refused first turn as a model mismatch",
      created: {
        firstTurn: {
          threadId: "th-reviewer",
          expected: ASKED,
          actual: OTHER,
          refused: true,
          refusal: null,
        },
        threadId: "th-reviewer",
        unknown: false,
        busy: false,
      },
      expected: {
        outcome: "model_mismatch",
        threadId: "th-reviewer",
        expected: ASKED,
        actual: OTHER,
      },
    },
    {
      name: "a seen thread that could not be recorded as unknown with its id",
      created: {
        firstTurn: {
          threadId: "th-reviewer",
          expected: ASKED,
          actual: ASKED,
          refused: false,
          refusal: null,
        },
        threadId: "th-reviewer",
        unknown: true,
        busy: false,
      },
      expected: { outcome: "unknown", threadId: "th-reviewer" },
    },
  ])("reports $name", async ({ created, expected }) => {
    const { gateway } = setup({ claude: [CLAUDE], created });

    const answer = await gateway.handle(
      JSON.stringify({
        threadId: CLAUDE,
        tool: "create_thread",
        arguments: { prompt: "review" },
      }),
    );

    expect(JSON.parse(answer)).toMatchObject(expected);
  });
});

describe("createCallGateway protocol 1", () => {
  test("answers the version query with the operations it offers", async () => {
    const { gateway, requests } = setup();

    const answer = await gateway.handle(
      JSON.stringify({ version: 1, query: "capabilities" }),
    );

    expect(JSON.parse(answer)).toEqual({
      version: 1,
      outcome: "done",
      operations: [
        "list_projects",
        "create_thread",
        "send_message_to_thread",
        "read_thread",
        "wait_threads",
        "name_thread",
        "cloud_chat",
        "cloud_open",
      ],
    });
    expect(requests).toEqual([]);
  });

  test("refuses a version it does not know, naming the one it offers", async () => {
    const { gateway } = setup();

    const answer = await gateway.handle(
      JSON.stringify({ version: 2, query: "capabilities" }),
    );

    expect(JSON.parse(answer)).toMatchObject({
      outcome: "invalid",
      versions: [1],
    });
  });

  test("answers cloud_open as invalid in the first protocol, as a bridge without it does", async () => {
    const { gateway, requests } = setup();

    const answer = await gateway.handle(
      JSON.stringify({ threadId: CODEX, tool: "cloud_open", arguments: {} }),
    );

    expect(JSON.parse(answer).outcome).toBe("invalid");
    expect(requests).toEqual([]);
  });

  test("names an answer the app marks as an error as rejected rather than a tool error", async () => {
    const { gateway } = setup({
      answer: () =>
        Result.ok({
          content: [{ type: "text", text: "thread not found" }],
          isError: true,
        }),
    });

    const answer = await gateway.handle(
      JSON.stringify({ version: 1, threadId: CODEX, tool: "read_thread" }),
    );

    expect(JSON.parse(answer)).toEqual({
      version: 1,
      outcome: "rejected",
      message: "thread not found",
      result: {
        content: [{ type: "text", text: "thread not found" }],
        isError: true,
      },
    });
  });

  test.each([
    { kind: "not_sent" as const },
    { kind: "unknown" as const },
    { kind: "invalid" as const },
  ])("names a Claude thread's failed write as $kind", async ({ kind }) => {
    const { gateway } = setup({
      claude: [CLAUDE],
      linkAnswer: () => failure("written for Claude", kind),
    });

    const answer = await gateway.handle(
      JSON.stringify({
        version: 1,
        threadId: CLAUDE,
        tool: "send_message_to_thread",
        arguments: { threadId: "t", prompt: "hi" },
      }),
    );

    expect(JSON.parse(answer)).toMatchObject({
      version: 1,
      outcome: kind,
      message: "written for Claude",
    });
  });

  test("keeps the tool error of the first protocol for a caller that names no version", async () => {
    const { gateway } = setup({
      claude: [CLAUDE],
      linkAnswer: () => failure("written for Claude", "not_sent"),
    });

    const answer = await gateway.handle(
      JSON.stringify({
        threadId: CLAUDE,
        tool: "send_message_to_thread",
        arguments: { threadId: "t", prompt: "hi" },
      }),
    );

    expect(JSON.parse(answer).outcome).toBe("tool_error");
  });
});

describe("createCallGateway cloud_open", () => {
  test("opens a Claude chat that links the session, in the project named", async () => {
    const { gateway, requests, watch } = setup({
      answer: () => {
        watch.observe(CODEX, "th-cloud", {
          model: "claude-sonnet-5-5",
          effort: "high",
        });
        return Result.ok(CLIENT_ANSWER);
      },
    });

    const answer = await cloudOpen(gateway, {
      link: `https://claude.ai/code/${SESSION}`,
      projectId: "p1",
      title: "README",
    });

    expect(answer).toEqual({
      version: 1,
      outcome: "done",
      result: {
        threadId: "th-cloud",
        cloudSessionId: SESSION,
        url: `https://claude.ai/code/${SESSION}`,
      },
      model: "claude-sonnet-5-5",
      effort: "high",
    });
    expect(requests.map((request) => request.params)).toEqual([
      {
        threadId: CODEX,
        server: "codex_app",
        tool: "create_thread",
        arguments: {
          prompt: `/cloud ${SESSION}`,
          target: {
            type: "project",
            projectId: "p1",
            environment: { type: "local" },
          },
          title: "☁️ README",
          model: "claude-sonnet-5-5",
          thinking: "high",
        },
      },
    ]);
  });

  test("answers a session already linked with its chat, opening none", async () => {
    const { gateway, requests } = setup();

    const answer = await cloudOpen(gateway, { link: "session_01Linked" });

    expect(answer).toMatchObject({
      outcome: "done",
      result: { threadId: "linked-chat", alreadyLinked: true },
    });
    expect(requests).toEqual([]);
  });

  test("refuses a second chat for a session it opened one for", async () => {
    const { gateway, watch } = setup({
      answer: () => {
        watch.observe(CODEX, "th-cloud", { model: "m", effort: "high" });
        return Result.ok(CLIENT_ANSWER);
      },
    });

    await cloudOpen(gateway, { link: SESSION, projectId: "p1", model: "m" });
    const again = await cloudOpen(gateway, { link: SESSION, projectId: "p1" });

    expect(again).toMatchObject({
      outcome: "rejected",
      cloudSessionId: SESSION,
    });
    expect(String(again.message)).toContain("th-cloud");
  });

  test("frees the session for another try when the chat was surely not created", async () => {
    let calls = 0;
    const { gateway, requests } = setup({
      answer: () => {
        calls += 1;
        return Result.err({ _tag: "ServerRequestNotSent", message: "closed" });
      },
    });

    const first = await cloudOpen(gateway, { link: SESSION, projectId: "p1" });
    const second = await cloudOpen(gateway, { link: SESSION, projectId: "p1" });

    expect(first).toMatchObject({
      outcome: "not_sent",
      cloudSessionId: SESSION,
    });
    expect(second.outcome).toBe("not_sent");
    expect(calls).toBe(2);
    expect(requests).toHaveLength(2);
  });

  test("starts a session from a prompt in the folder of the project holding cwd", async () => {
    const started: { prompt: string; cwd: string }[] = [];
    const { gateway, requests, watch } = setup({
      answer: () => {
        if (requests.length === 1) return Result.ok(PROJECTS);
        watch.observe(CODEX, "th-cloud", { model: "m", effort: "high" });
        return Result.ok(CLIENT_ANSWER);
      },
      startCloud: async (prompt, cwd) => {
        started.push({ prompt, cwd });
        return Result.ok({ sessionId: SESSION, title: "Fix typo" });
      },
    });

    const answer = await cloudOpen(gateway, {
      prompt: "fix the typo",
      cwd: "/work/app/src",
      model: "m",
    });

    expect(started).toEqual([{ prompt: "fix the typo", cwd: "/work/app" }]);
    expect(answer).toMatchObject({
      outcome: "done",
      result: { threadId: "th-cloud", cloudSessionId: SESSION },
    });
    expect(requests[1]?.params).toMatchObject({
      arguments: { title: "☁️ Fix typo" },
    });
  });

  test("names a start that did not report its session as unknown, opening no chat", async () => {
    const { gateway, requests } = setup({
      answer: () => Result.ok(PROJECTS),
      startCloud: async () => Result.err({ message: "timed out" }),
    });

    const answer = await cloudOpen(gateway, {
      prompt: "fix",
      projectId: "p1",
    });

    expect(answer.outcome).toBe("unknown");
    expect(requests).toHaveLength(1);
  });

  test.each([
    { name: "both a link and a prompt", args: { link: SESSION, prompt: "x" } },
    { name: "neither a link nor a prompt", args: {} },
    { name: "a link that names no session", args: { link: "nope" } },
    { name: "a relative cwd", args: { link: SESSION, cwd: "work" } },
  ])("refuses $name before calling the app", async ({ args }) => {
    const { gateway, requests } = setup();

    const answer = await cloudOpen(gateway, args);

    expect(answer.outcome).toBe("invalid");
    expect(requests).toEqual([]);
  });
});

const cloudOpen = async (
  gateway: ReturnType<typeof setup>["gateway"],
  args: Record<string, unknown>,
) =>
  JSON.parse(
    await gateway.handle(
      JSON.stringify({
        version: 1,
        threadId: CODEX,
        tool: "cloud_open",
        arguments: args,
      }),
    ),
  ) as Record<string, unknown>;

const SESSION = "session_01NfjPqrX1AK5RmKyV182VYD";
const PROJECTS = {
  content: [],
  structuredContent: {
    projects: [
      { projectId: "p1", path: "/work/app" },
      { projectId: "p2", path: "/work/other" },
    ],
  },
};

const setup = ({
  answer = () => Result.ok({ content: [] }),
  claude = [],
  created = {
    firstTurn: {
      threadId: "th-reviewer",
      expected: { model: "gpt-x", effort: null },
      actual: { model: "gpt-x", effort: null },
      refused: false,
      refusal: null,
    },
    threadId: "th-reviewer",
    unknown: false,
    busy: false,
  },
  armedMs = 600_000,
  linkAnswer = (tool) => ({
    content: [{ type: "text", text: `linked ${tool}` }],
  }),
  startCloud,
}: {
  linkAnswer?: (tool: string) => ToolResult;
  startCloud?: StartCloud;
  // The real errors are told apart by their tag alone.
  answer?: () => Result<unknown, { _tag: string; message: string }>;
  claude?: readonly string[];
  created?: {
    firstTurn: FirstTurn | null;
    threadId: string | null;
    unknown: boolean;
    busy: boolean;
  };
  armedMs?: number;
} = {}) => {
  const watch = createDelegationWatch({ armedMs });
  const requests: {
    method: string;
    params: unknown;
    timeoutMs: number | null;
  }[] = [];
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
          return linkAnswer(tool);
        },
        createChecked: async (args) => {
          linkCalls.push({ tool: "checked create_thread", args });
          return {
            result: {
              content: [{ type: "text", text: "linked create_thread" }],
            },
            ...created,
          };
        },
      };
    },
    request,
    delegations: watch,
    cloudOwner: (sessionId) =>
      sessionId === "session_01Linked" ? "linked-chat" : undefined,
    firstTurnWaitMs: 50,
    ...(startCloud !== undefined && { startCloud }),
  });
  return { gateway, requests, linkCalls, opened, watch };
};

const CODEX = "codex-thread";
const CLAUDE = "claude-thread";

const ASKED = { model: "gpt-worker", effort: "low" };
const OTHER = { model: "gpt-other", effort: "low" };
const CLIENT_ANSWER = {
  content: [
    {
      type: "text",
      text: '{"clientThreadId":"client-new-thread:1","hostId":"local"}',
    },
  ],
};
const CREATE = JSON.stringify({
  threadId: CODEX,
  tool: "create_thread",
  arguments: { prompt: "work", model: "gpt-worker", thinking: "low" },
});
const NAMED_ANSWER = {
  content: [{ type: "text", text: '{"threadId":"th-named"}' }],
};
