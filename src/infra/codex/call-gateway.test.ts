import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { createCallGateway } from "./call-gateway.ts";
import { createDelegationWatch, type FirstTurn } from "./delegations.ts";
import type { ServerRequest } from "./server-requests.ts";

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
  ])("answers from a first turn already seen when the call is $name", async ({
    tag,
    seen,
    expected,
  }) => {
    const { gateway, watch } = setup({
      answer: () => {
        watch.observe(CODEX, "th-worker", seen);
        return Result.err({ _tag: tag, message: "failed" });
      },
    });

    const answer = JSON.parse(await gateway.handle(CREATE));

    expect(answer).toMatchObject(expected);
  });

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
}: {
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
  const watch = createDelegationWatch(() => {}, { armedMs });
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
    firstTurnWaitMs: 50,
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
