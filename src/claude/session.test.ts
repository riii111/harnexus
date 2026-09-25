import { describe, expect, test } from "bun:test";
import type {
  AccountInfo,
  CanUseTool,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { failingRun, fakeClaude } from "../boundary/testing/fake-claude.ts";
import { type ClaudeSessionSettings, startClaudeSession } from "./session.ts";

describe("startClaudeSession options", () => {
  test("loads every settings source with the Claude Code preset in the worktree", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    await startClaudeSession(SETTINGS, claude.run);

    expect(claude.options()).toMatchObject({
      cwd: "/work/tree",
      model: "claude-sonnet-5",
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "default",
      includePartialMessages: true,
      mcpServers: {},
    });
    expect(claude.options().resume).toBeUndefined();
  });

  test("appends nothing to the preset system prompt", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    await startClaudeSession(SETTINGS, claude.run);

    expect(claude.options().systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
    });
  });

  test("resumes the given session with the given MCP servers", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const mcpServers = { harnexus: { command: "harnexus-mcp" } };

    await startClaudeSession(
      { ...SETTINGS, resume: "session-1", mcpServers },
      claude.run,
    );

    expect(claude.options()).toMatchObject({ resume: "session-1", mcpServers });
  });

  test("keeps API billing variables away from Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    await startClaudeSession(
      {
        ...SETTINGS,
        env: {
          PATH: "/usr/bin",
          HOME: "/home/user",
          CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
          ANTHROPIC_API_KEY: "api-key",
          ANTHROPIC_AUTH_TOKEN: "bearer",
          CLAUDE_CODE_USE_BEDROCK: "1",
        },
      },
      claude.run,
    );

    expect(claude.options().env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/user",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
    });
  });

  test("denies every tool that asks for approval", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    await startClaudeSession(SETTINGS, claude.run);
    const canUseTool = claude.options().canUseTool as CanUseTool;
    const decision = await canUseTool(
      "Bash",
      { command: "rm -rf build" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-1",
        requestId: "request-1",
      },
    );

    expect(decision).toEqual({
      behavior: "deny",
      message: expect.stringContaining("Bash"),
    });
  });
});

describe("startClaudeSession authentication", () => {
  test("starts on a claude.ai subscription login", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    const started = await startClaudeSession(SETTINGS, claude.run);

    expect(started.isOk()).toBe(true);
    expect(claude.closes()).toBe(0);
  });

  test.each([
    ["an API key", { ...SUBSCRIPTION, apiKeySource: "ANTHROPIC_API_KEY" }],
    ["an API key helper", { ...SUBSCRIPTION, apiKeySource: "apiKeyHelper" }],
    ["a cloud provider", { apiProvider: "bedrock" as const }],
    ["a login without a subscription", { apiProvider: "firstParty" as const }],
  ])("stops before any prompt on %s", async (_label, account: AccountInfo) => {
    const claude = fakeClaude(account);

    const started = await startClaudeSession(SETTINGS, claude.run);

    expect(started.isErr() && started.error._tag).toBe("ClaudeNotSubscription");
    expect(claude.closes()).toBe(1);
    expect(await claude.prompts()).toEqual([]);
  });

  test("stops when the account cannot be read", async () => {
    const claude = fakeClaude(new Error("initialize timed out"));

    const started = await startClaudeSession(SETTINGS, claude.run);

    expect(started.isErr() && started.error._tag).toBe(
      "ClaudeAccountUnavailable",
    );
    expect(claude.closes()).toBe(1);
  });

  test("reports an SDK that fails to start", async () => {
    const started = await startClaudeSession(
      SETTINGS,
      failingRun(new Error("claude executable not found")),
    );

    expect(started.isErr() && started.error._tag).toBe("ClaudeStartFailed");
  });
});

describe("ClaudeSession", () => {
  test("sends the prompt text as a user message", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    expect(session.send("review the diff").isOk()).toBe(true);
    expect(session.send("also run the tests").isOk()).toBe(true);
    session.close();

    expect(await claude.prompts()).toEqual([
      userMessage("review the diff"),
      userMessage("also run the tests"),
    ]);
  });

  test("streams messages until the SDK ends", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    claude.emit(sdkMessage("first"));
    claude.emit(sdkMessage("second"));
    claude.end();
    const received = await collect(session.messages);

    expect(received.map((item) => item.isOk() && item.value)).toEqual([
      sdkMessage("first"),
      sdkMessage("second"),
    ]);
    expect(claude.closes()).toBe(1);
  });

  test("ends the stream with an error when the SDK throws", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    claude.emit(sdkMessage("first"));
    claude.fail(new Error("Claude Code process exited with code 1"));
    const received = await collect(session.messages);

    expect(received.map((item) => item.isOk())).toEqual([true, false]);
    const failure = received[1];
    expect(failure?.isErr() && failure.error._tag).toBe("ClaudeStreamFailed");
    expect(claude.closes()).toBe(1);
    expect(session.send("again").isErr()).toBe(true);
  });

  test("interrupts the running turn and keeps the session open", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    const interrupted = await session.interrupt();

    expect(interrupted.isOk()).toBe(true);
    expect(claude.interrupts()).toBe(1);
    expect(session.send("next turn").isOk()).toBe(true);
  });

  test("reports an interrupt the SDK rejects", async () => {
    const claude = fakeClaude(SUBSCRIPTION, new Error("not streaming"));
    const session = await startedSession(claude);

    const interrupted = await session.interrupt();

    expect(interrupted.isErr() && interrupted.error._tag).toBe(
      "ClaudeInterruptFailed",
    );
  });

  test("close ends the input and the stream without an error", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);
    const reading = collect(session.messages);

    session.close();
    session.close();

    expect(await reading).toEqual([]);
    expect(claude.closes()).toBe(1);
    expect(await claude.prompts()).toEqual([]);
  });

  test("refuses input and interrupts after close", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    session.close();
    const sent = session.send("late");
    const interrupted = await session.interrupt();

    expect(sent.isErr() && sent.error._tag).toBe("ClaudeSessionClosed");
    expect(interrupted.isErr() && interrupted.error._tag).toBe(
      "ClaudeSessionClosed",
    );
    expect(claude.interrupts()).toBe(0);
  });
});

const SETTINGS: ClaudeSessionSettings = {
  cwd: "/work/tree",
  model: "claude-sonnet-5",
  env: { PATH: "/usr/bin" },
};

const SUBSCRIPTION: AccountInfo = {
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};

const startedSession = async (claude: ReturnType<typeof fakeClaude>) =>
  (await startClaudeSession(SETTINGS, claude.run)).unwrap();

const collect = async <T>(items: AsyncIterable<T>) => {
  const collected: T[] = [];
  for await (const item of items) collected.push(item);
  return collected;
};

const userMessage = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

const sdkMessage = (label: string) =>
  ({
    type: "system",
    subtype: "status",
    status: null,
    uuid: label,
    session_id: "session-1",
  }) as unknown as SDKMessage;
