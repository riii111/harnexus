import { describe, expect, test } from "bun:test";
import type { UUID } from "node:crypto";
import type {
  AccountInfo,
  CanUseTool,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { failingQuery, fakeClaude } from "../boundary/testing/fake-claude.ts";
import { type ClaudeSessionSettings, startClaudeSession } from "./session.ts";

describe("startClaudeSession options", () => {
  test("loads every settings source with the Claude Code preset in the worktree", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    await startClaudeSession(SETTINGS, claude.sdk);

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

    await startClaudeSession(SETTINGS, claude.sdk);

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
      claude.sdk,
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
      claude.sdk,
    );

    expect(claude.options().env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/user",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
    });
  });

  test("keeps custom headers that cannot replace the login", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    await startClaudeSession(
      {
        ...SETTINGS,
        env: {
          ANTHROPIC_CUSTOM_HEADERS:
            "Authorization: Bearer other\r\nX-Trace: 1\nx-api-key: key",
        },
      },
      claude.sdk,
    );

    expect(claude.options().env).toEqual({
      ANTHROPIC_CUSTOM_HEADERS: "X-Trace: 1",
    });
  });

  test("drops custom headers made only of auth headers", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    await startClaudeSession(
      {
        ...SETTINGS,
        env: {
          PATH: "/usr/bin",
          ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer other",
        },
      },
      claude.sdk,
    );

    expect(claude.options().env).toEqual({ PATH: "/usr/bin" });
  });

  test("denies every tool that asks for approval", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    await startClaudeSession(SETTINGS, claude.sdk);
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

    const started = await startClaudeSession(SETTINGS, claude.sdk);

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

    const started = await startClaudeSession(SETTINGS, claude.sdk);

    expect(started.isErr() && started.error._tag).toBe("ClaudeNotSubscription");
    expect(claude.closes()).toBe(1);
    expect(await claude.prompts()).toEqual([]);
  });

  test("stops when the account cannot be read", async () => {
    const claude = fakeClaude(new Error("initialize timed out"));

    const started = await startClaudeSession(SETTINGS, claude.sdk);

    expect(started.isErr() && started.error._tag).toBe(
      "ClaudeAccountUnavailable",
    );
    expect(claude.closes()).toBe(1);
  });

  test.each([
    [
      "an Authorization header",
      { ANTHROPIC_CUSTOM_HEADERS: "X-Trace: 1\nauthorization: Bearer other" },
      "ANTHROPIC_CUSTOM_HEADERS",
    ],
    [
      "an x-api-key header",
      { ANTHROPIC_CUSTOM_HEADERS: "X-Api-Key: other" },
      "ANTHROPIC_CUSTOM_HEADERS",
    ],
    ["an API key", { ANTHROPIC_API_KEY: "api-key" }, "ANTHROPIC_API_KEY"],
    [
      "a gateway URL",
      { ANTHROPIC_BASE_URL: "https://gateway.example" },
      "ANTHROPIC_BASE_URL",
    ],
  ])("stops before starting Claude when settings set %s", async (_label, settingsEnv: Record<
    string,
    string
  >, name) => {
    const claude = fakeClaude(SUBSCRIPTION, { settingsEnv });

    const started = await startClaudeSession(SETTINGS, claude.sdk);

    expect(started.isErr() && started.error._tag).toBe(
      "ClaudeSettingsOverrideAuth",
    );
    expect(
      started.isErr() && "names" in started.error && started.error.names,
    ).toEqual([name]);
    expect(claude.started()).toBe(false);
  });

  test("starts when settings set only unrelated custom headers", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      settingsEnv: {
        ANTHROPIC_CUSTOM_HEADERS: "X-Trace: 1\r\nX-Team: core \n",
        FOO: "bar",
      },
    });

    const started = await startClaudeSession(SETTINGS, claude.sdk);

    expect(started.isOk()).toBe(true);
  });

  test("stops when the settings cannot be read", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      settingsEnv: new Error("invalid settings"),
    });

    const started = await startClaudeSession(SETTINGS, claude.sdk);

    expect(started.isErr() && started.error._tag).toBe(
      "ClaudeSettingsUnavailable",
    );
    expect(claude.started()).toBe(false);
  });

  test("reports an SDK that fails to start", async () => {
    const started = await startClaudeSession(SETTINGS, {
      ...fakeClaude(SUBSCRIPTION).sdk,
      query: failingQuery(new Error("claude executable not found")),
    });

    expect(started.isErr() && started.error._tag).toBe("ClaudeStartFailed");
  });
});

describe("ClaudeSession", () => {
  test("sends the prompt text as a user message stamped with a returned uuid", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    const first = session.send("review the diff").unwrap();
    const second = session.send("also run the tests").unwrap();
    session.close();

    expect(first).not.toBe(second);
    expect(await claude.prompts()).toEqual([
      userMessage("review the diff", first),
      userMessage("also run the tests", second),
    ]);
  });

  test("wakes the SDK waiting for input when a message is sent", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);
    const input = claude.prompt()?.[Symbol.asyncIterator]();
    const waiting = input?.next();

    const uuid = session.send("steer to the failing test").unwrap();

    expect(await waiting).toEqual({
      done: false,
      value: userMessage("steer to the failing test", uuid),
    });
    session.close();
    expect(await input?.next()).toEqual({ done: true, value: undefined });
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

  test("refuses input while the consumer handles a stream failure", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    expect.assertions(3);
    claude.fail(new Error("Claude Code process exited with code 1"));
    for await (const item of session.messages) {
      expect(item.isErr()).toBe(true);
      expect(claude.closes()).toBe(1);
      expect(session.send("steer").isErr()).toBe(true);
    }
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

  test("reports the sends that survive an interrupt", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: ["uuid-1"] });
    const session = await startedSession(claude);

    const interrupted = await session.interrupt();

    expect(interrupted.unwrap()).toEqual(["uuid-1"]);
  });

  test("reports no surviving sends when the CLI gives no receipt", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    const interrupted = await session.interrupt();

    expect(interrupted.unwrap()).toBeNull();
  });

  test("reports an interrupt the SDK rejects", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      interruptError: new Error("not streaming"),
    });
    const session = await startedSession(claude);

    const interrupted = await session.interrupt();

    expect(interrupted.isErr() && interrupted.error._tag).toBe(
      "ClaudeInterruptFailed",
    );
  });

  test.each([
    ["ends", undefined],
    ["fails", new Error("Operation aborted")],
  ])("close ends the input and the stream when the pending read %s", async (_label, closeEnding) => {
    const claude = fakeClaude(
      SUBSCRIPTION,
      closeEnding === undefined ? {} : { closeEnding },
    );
    const session = await startedSession(claude);
    const reading = collect(session.messages);

    session.close();
    session.close();

    expect(await reading).toEqual([]);
    expect(claude.closes()).toBe(1);
    expect(await claude.prompts()).toEqual([]);
  });

  test("stops Claude when the consumer stops reading", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    claude.emit(sdkMessage("first"));
    claude.emit(sdkMessage("second"));
    for await (const _item of session.messages) break;

    expect(claude.closes()).toBe(1);
    expect(session.send("unheard").isErr()).toBe(true);
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
  (await startClaudeSession(SETTINGS, claude.sdk)).unwrap();

const collect = async <T>(items: AsyncIterable<T>) => {
  const collected: T[] = [];
  for await (const item of items) collected.push(item);
  return collected;
};

const userMessage = (text: string, uuid: UUID): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  uuid,
});

const sdkMessage = (label: string) =>
  ({
    type: "system",
    subtype: "status",
    status: null,
    uuid: label,
    session_id: "session-1",
  }) as unknown as SDKMessage;
