import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountInfo,
  resolveSettings,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ClaudeSessionSettings,
  claudeSessionExists,
  startClaudeSession,
} from "./session.ts";
import { failingQuery, fakeClaude } from "./testing/fake-claude.ts";

describe("startClaudeSession options", () => {
  test("loads every settings source with the Claude Code preset in the worktree", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    await startClaudeSession(SETTINGS, claude.runtime);

    expect(claude.options()).toMatchObject({
      cwd: "/work/tree",
      model: "claude-sonnet-5",
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "default",
      includePartialMessages: true,
      mcpServers: {},
      allowedTools: [],
    });
    expect(claude.options().systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
    });
    expect(claude.options().resume).toBeUndefined();
  });

  test("resumes the given session with the given MCP servers and their allowed tools", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const mcpServers = { harnexus: { command: "harnexus-mcp" } };
    const allowedTools = ["mcp__harnexus__read"];

    await startClaudeSession(
      { ...SETTINGS, resume: "session-1", mcpServers, allowedTools },
      claude.runtime,
    );

    expect(claude.options()).toMatchObject({
      resume: "session-1",
      mcpServers,
      allowedTools,
    });
  });

  test("keeps API billing variables away from Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      env: {
        PATH: "/usr/bin",
        HOME: "/home/user",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
        ANTHROPIC_API_KEY: "api-key",
        ANTHROPIC_AUTH_TOKEN: "bearer",
        CLAUDE_CODE_USE_BEDROCK: "1",
      },
    });

    await startClaudeSession(SETTINGS, claude.runtime);

    expect(claude.options().env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/user",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
    });
  });

  test("keeps custom headers that cannot replace the login", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      env: {
        ANTHROPIC_CUSTOM_HEADERS:
          "Authorization: Bearer other\r\nX-Trace: 1\nx-api-key: key",
      },
    });

    await startClaudeSession(SETTINGS, claude.runtime);

    expect(claude.options().env).toEqual({
      ANTHROPIC_CUSTOM_HEADERS: "X-Trace: 1",
    });
  });

  test("drops custom headers made only of auth headers", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      env: {
        PATH: "/usr/bin",
        ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer other",
      },
    });

    await startClaudeSession(SETTINGS, claude.runtime);

    expect(claude.options().env).toEqual({ PATH: "/usr/bin" });
  });

  test("asks the given canUseTool about tools that need approval", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    await startClaudeSession(SETTINGS, claude.runtime);

    expect(claude.options().canUseTool).toBe(SETTINGS.canUseTool);
  });
});

describe("startClaudeSession authentication", () => {
  test("stops before any prompt on a login without a subscription", async () => {
    const claude = fakeClaude({ apiProvider: "firstParty" });

    const started = await startClaudeSession(SETTINGS, claude.runtime);

    expect(started.isErr() && started.error._tag).toBe("ClaudeNotSubscription");
    expect(claude.closes()).toBe(1);
    expect(await claude.prompts()).toEqual([]);
  });

  test("stops when the account cannot be read", async () => {
    const claude = fakeClaude(new Error("initialize timed out"));

    const started = await startClaudeSession(SETTINGS, claude.runtime);

    expect(started.isErr() && started.error._tag).toBe(
      "ClaudeAccountUnavailable",
    );
    expect(claude.closes()).toBe(1);
  });

  test.each([
    {
      name: "an Authorization header",
      settingsEnv: {
        ANTHROPIC_CUSTOM_HEADERS: "X-Trace: 1\nauthorization: Bearer other",
      },
      expected: "ANTHROPIC_CUSTOM_HEADERS",
    },
    {
      name: "an x-api-key header",
      settingsEnv: { ANTHROPIC_CUSTOM_HEADERS: "X-Api-Key: other" },
      expected: "ANTHROPIC_CUSTOM_HEADERS",
    },
    {
      name: "an API key",
      settingsEnv: { ANTHROPIC_API_KEY: "api-key" },
      expected: "ANTHROPIC_API_KEY",
    },
    {
      name: "a gateway URL",
      settingsEnv: { ANTHROPIC_BASE_URL: "https://gateway.example" },
      expected: "ANTHROPIC_BASE_URL",
    },
  ])("stops before starting Claude when settings set $name", async ({
    settingsEnv,
    expected,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION, { settingsEnv });

    const started = await startClaudeSession(SETTINGS, claude.runtime);

    expect(started.isErr() && started.error).toMatchObject({
      _tag: "ClaudeSettingsOverrideAuth",
      names: [expected],
    });
    expect(claude.started()).toBe(false);
  });

  test("starts when settings set only unrelated custom headers", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      settingsEnv: {
        ANTHROPIC_CUSTOM_HEADERS: "X-Trace: 1\r\nX-Team: core \n",
        FOO: "bar",
      },
    });

    const started = await startClaudeSession(SETTINGS, claude.runtime);

    expect(started.isOk()).toBe(true);
  });

  test("stops when the settings cannot be read", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      settingsEnv: new Error("invalid settings"),
    });

    const started = await startClaudeSession(SETTINGS, claude.runtime);

    expect(started.isErr() && started.error._tag).toBe(
      "ClaudeSettingsUnavailable",
    );
    expect(claude.started()).toBe(false);
  });

  test("reports an SDK that fails to start", async () => {
    const started = await startClaudeSession(SETTINGS, {
      ...fakeClaude(SUBSCRIPTION).runtime,
      query: failingQuery(new Error("claude executable not found")),
    });

    expect(started.isErr() && started.error._tag).toBe("ClaudeStartFailed");
  });
});

describe("startClaudeSession settings directory", () => {
  let configDir = "";
  let previous: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "harnexus-claude-config-"));
    previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("checks the settings Claude reads from its config directory", async () => {
    writeUserSettings(configDir, {
      ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer other",
    });
    const claude = fakeClaude(SUBSCRIPTION);

    const started = await startClaudeSession(
      { ...SETTINGS, cwd: configDir },
      { ...claude.runtime, resolveSettings, env: process.env },
    );

    expect(started.isErr() && started.error._tag).toBe(
      "ClaudeSettingsOverrideAuth",
    );
    expect(claude.started()).toBe(false);
  });

  test("gives Claude the config directory that was checked", async () => {
    writeUserSettings(configDir, { ANTHROPIC_CUSTOM_HEADERS: "X-Trace: 1" });
    const claude = fakeClaude(SUBSCRIPTION);

    const started = await startClaudeSession(
      { ...SETTINGS, cwd: configDir },
      { ...claude.runtime, resolveSettings, env: process.env },
    );

    expect(started.isOk()).toBe(true);
    expect(claude.options().env?.CLAUDE_CONFIG_DIR).toBe(configDir);
  });
});

describe("startClaudeSession started session", () => {
  test("sends the prompt text as a user message stamped with a returned uuid", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    const first = session.send("review the diff");
    if (first.isErr()) return expect.unreachable(first.error.message);
    const second = session.send("also run the tests");
    if (second.isErr()) return expect.unreachable(second.error.message);
    session.close();

    expect(first.value).not.toBe(second.value);
    expect(await claude.prompts()).toEqual([
      userMessage("review the diff", first.value),
      userMessage("also run the tests", second.value),
    ]);
  });

  test("wakes the SDK waiting on the prompt when a message is sent", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);
    const prompt = claude.prompt()?.[Symbol.asyncIterator]();
    const waiting = prompt?.next();

    const sent = session.send("steer to the failing test");
    if (sent.isErr()) return expect.unreachable(sent.error.message);

    expect(await waiting).toEqual({
      done: false,
      value: userMessage("steer to the failing test", sent.value),
    });
    session.close();
    expect(await prompt?.next()).toEqual({ done: true, value: undefined });
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
      expect(item.isErr() && item.error._tag).toBe("ClaudeStreamFailed");
      expect(claude.closes()).toBe(1);
      const sent = session.send("steer");
      expect(sent.isErr() && sent.error._tag).toBe("ClaudeSessionClosed");
    }
  });

  test("interrupts the running turn and keeps the session open", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    const interrupted = await session.interrupt();

    expect(interrupted.isOk() && interrupted.value).toBeNull();
    expect(claude.interrupts()).toBe(1);
    expect(session.send("next turn").isOk()).toBe(true);
  });

  test("reports the sends that survive an interrupt", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { stillQueued: ["uuid-1"] });
    const session = await startedSession(claude);

    const interrupted = await session.interrupt();

    expect(interrupted.isOk() && interrupted.value).toEqual(["uuid-1"]);
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
    { name: "ends", options: {} },
    {
      name: "fails",
      options: { closeEnding: new Error("Operation aborted") },
    },
  ])("close ends the prompt and the stream when the pending read $name", async ({
    options,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION, options);
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
    const sent = session.send("unheard");
    expect(sent.isErr() && sent.error._tag).toBe("ClaudeSessionClosed");
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

  test("switches Claude's permission mode until closed", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    const switched = await session.setPermissionMode("plan");
    session.close();
    const late = await session.setPermissionMode("default");

    expect(switched.isOk()).toBe(true);
    expect(late.isErr() && late.error._tag).toBe("ClaudeSessionClosed");
    expect(claude.modes()).toEqual(["plan"]);
  });
});

describe("claudeSessionExists", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "harnexus-claude-config-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test.each([
    { name: "a readable record", mode: 0o600 },
    { name: "a record the bridge cannot read", mode: 0o000 },
  ])("finds $name by its file name", async ({ mode }) => {
    const record = join(configDir, "projects", "-work-tree", "se-1.jsonl");
    mkdirSync(join(configDir, "projects", "-work-tree"), { recursive: true });
    writeFileSync(record, "{}\n");
    chmodSync(record, mode);

    const found = await claudeSessionExists("se-1", configDir);

    expect(found.isOk() && found.value).toBe(true);
  });

  test.each([
    { name: "no projects folder", projects: [] as string[] },
    { name: "project folders without it", projects: ["-work-tree", "-other"] },
  ])("reports a record missing from $name as missing", async ({ projects }) => {
    for (const project of projects) {
      mkdirSync(join(configDir, "projects", project), { recursive: true });
      writeFileSync(join(configDir, "projects", project, "se-2.jsonl"), "");
    }

    const found = await claudeSessionExists("se-1", configDir);

    expect(found.isOk() && found.value).toBe(false);
  });

  test("finds a record in a project folder reached through a symbolic link", async () => {
    const linked = join(configDir, "elsewhere");
    mkdirSync(linked);
    writeFileSync(join(linked, "se-1.jsonl"), "{}\n");
    mkdirSync(join(configDir, "projects"));
    symlinkSync(linked, join(configDir, "projects", "-work-tree"));

    const found = await claudeSessionExists("se-1", configDir);

    expect(found.isOk() && found.value).toBe(true);
  });

  test("skips a file beside the project folders", async () => {
    const project = join(configDir, "projects", "-work-tree");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(configDir, "projects", ".DS_Store"), "");
    writeFileSync(join(project, "se-1.jsonl"), "{}\n");

    const found = await claudeSessionExists("se-1", configDir);

    expect(found.isOk() && found.value).toBe(true);
  });

  test("reports a project folder it cannot list as an error rather than missing", async () => {
    const project = join(configDir, "projects", "-work-tree");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "se-1.jsonl"), "{}\n");
    chmodSync(project, 0o000);

    const found = await claudeSessionExists("se-1", configDir);
    chmodSync(project, 0o700);

    expect(found.isErr() && found.error._tag).toBe("FileReadFailed");
  });
});

const SETTINGS: ClaudeSessionSettings = {
  cwd: "/work/tree",
  model: "claude-sonnet-5",
  canUseTool: async () => ({ behavior: "deny", message: "not in this test" }),
};

const SUBSCRIPTION: AccountInfo = {
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};

const writeUserSettings = (dir: string, env: Record<string, string>) =>
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ env }));

const startedSession = async (claude: ReturnType<typeof fakeClaude>) => {
  const started = await startClaudeSession(SETTINGS, claude.runtime);
  if (started.isErr()) return expect.unreachable(started.error.message);
  return started.value;
};

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
