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
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { Result } from "better-result";
import {
  SUBSCRIPTION_CONNECTION,
  type VertexConnection,
} from "./connection.ts";
import {
  type ClaudeSessionSettings,
  claudeSessionExists,
  loadClaudeModels,
  loadEffortSettings,
  readClaudeLogin,
  readClaudeSession,
  readClaudeSubagents,
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
      permissionMode: "auto",
      includePartialMessages: true,
      forwardSubagentText: true,
      mcpServers: {},
      allowedTools: [],
      canUseTool: SETTINGS.canUseTool,
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

  test("forks the resumed session into a new one up to the given record when asked", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    await startClaudeSession(
      { ...SETTINGS, resume: "session-1", forkSession: true, resumeAt: "a-1" },
      claude.runtime,
    );

    expect(claude.options()).toMatchObject({
      resume: "session-1",
      forkSession: true,
      resumeSessionAt: "a-1",
    });
  });

  test("keeps API billing variables and auth headers away from Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      env: {
        PATH: "/usr/bin",
        HOME: "/home/user",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
        ANTHROPIC_API_KEY: "api-key",
        ANTHROPIC_AUTH_TOKEN: "bearer",
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer other\r\nX-Trace: 1",
      },
    });

    await startClaudeSession(SETTINGS, claude.runtime);

    expect(claude.options().env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/user",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
      ANTHROPIC_CUSTOM_HEADERS: "X-Trace: 1",
    });
  });

  test.each([
    {
      name: "names the thread it runs when the call socket is open",
      exposeThreadId: true,
      expected: "th-fixture",
    },
    {
      name: "keeps the inherited value when the call socket is closed",
      exposeThreadId: false,
      expected: "th-bridge",
    },
  ])("CODEX_THREAD_ID for Claude's tools $name", async ({
    exposeThreadId,
    expected,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION, {
      env: { PATH: "/usr/bin", CODEX_THREAD_ID: "th-bridge" },
    });

    await startClaudeSession({ ...SETTINGS, exposeThreadId }, claude.runtime);

    expect(claude.options().env).toEqual({
      PATH: "/usr/bin",
      CODEX_THREAD_ID: expected,
    });
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
  ])("stops before starting Claude when the repository's settings set $name", async ({
    settingsEnv,
    expected,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION, {
      settingsEnv,
      userSettingsEnv: {},
    });

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

describe("startClaudeSession Vertex connection", () => {
  test("starts Claude on the repository's Vertex project once Claude Code reports Vertex", async () => {
    const claude = fakeClaude(
      { apiProvider: "vertex" },
      { env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "api-key" } },
    );

    const started = await startClaudeSession(VERTEX_SETTINGS, claude.runtime);

    expect(started.isOk()).toBe(true);
    expect(claude.options().env).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "sidework-project",
      CLOUD_ML_REGION: "global",
    });
  });

  test("stops before starting Claude when the user's settings choose Vertex, even with the repository's values", async () => {
    const claude = fakeClaude(
      { apiProvider: "vertex" },
      { settingsEnv: VERTEX.env, userSettingsEnv: VERTEX.env },
    );

    const started = await startClaudeSession(VERTEX_SETTINGS, claude.runtime);

    expect(started.isErr() && started.error).toMatchObject({
      _tag: "ClaudeSettingsOverrideAuth",
      names: [
        "CLAUDE_CODE_USE_VERTEX",
        "ANTHROPIC_VERTEX_PROJECT_ID",
        "CLOUD_ML_REGION",
      ],
    });
    expect(claude.started()).toBe(false);
  });

  test("passes the repository's Vertex variables as flag settings over a worktree's shared settings", async () => {
    const claude = fakeClaude(
      { apiProvider: "vertex" },
      {
        settingsEnv: { ANTHROPIC_VERTEX_PROJECT_ID: "shared-project" },
        userSettingsEnv: {},
      },
    );

    const started = await startClaudeSession(VERTEX_SETTINGS, claude.runtime);

    expect(started.isOk()).toBe(true);
    expect(claude.options().settings).toEqual({ env: VERTEX.env });
  });

  test("starts when only the repository's settings repeat its Vertex values", async () => {
    const claude = fakeClaude(
      { apiProvider: "vertex" },
      { settingsEnv: VERTEX.env, userSettingsEnv: {} },
    );

    const started = await startClaudeSession(VERTEX_SETTINGS, claude.runtime);

    expect(started.isOk()).toBe(true);
  });
});

describe("startClaudeSession settings directory", () => {
  let configDir = "";

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "harnexus-claude-config-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("checks the settings Claude reads from its config directory", async () => {
    writeUserSettings(configDir, {
      ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer other",
    });
    const claude = fakeClaude(SUBSCRIPTION);

    const started = await withConfigDir(configDir, () =>
      startClaudeSession(
        { ...SETTINGS, cwd: configDir },
        { ...claude.runtime, resolveSettings, env: process.env },
      ),
    );

    expect(started.isErr() && started.error._tag).toBe(
      "ClaudeSettingsOverrideAuth",
    );
    expect(claude.started()).toBe(false);
  });
});

describe("startClaudeSession started session", () => {
  test("wakes the SDK waiting on the prompt when a message is sent", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);
    const prompt = claude.prompt()?.[Symbol.asyncIterator]();
    const waiting = prompt?.next();

    const sent = session.send({ text: "steer to the failing test" });
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
      const sent = session.send({ text: "steer" });
      expect(sent.isErr() && sent.error._tag).toBe("ClaudeSessionClosed");
    }
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

  test("close ends the prompt and the stream when the pending read fails", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      closeEnding: new Error("Operation aborted"),
    });
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
    const sent = session.send({ text: "unheard" });
    expect(sent.isErr() && sent.error._tag).toBe("ClaudeSessionClosed");
  });

  test.each<{
    name: string;
    act: (
      session: StartedSession,
    ) => Promise<Result<unknown, { _tag: string }>>;
    reached: (claude: ReturnType<typeof fakeClaude>) => unknown;
    none: unknown;
  }>([
    {
      name: "input",
      act: async (session) => session.send({ text: "late" }),
      reached: (claude) => claude.prompts(),
      none: [],
    },
    {
      name: "an interrupt",
      act: (session) => session.interrupt(),
      reached: (claude) => claude.interrupts(),
      none: 0,
    },
    {
      name: "a permission mode change",
      act: (session) => session.setPermissionMode("plan"),
      reached: (claude) => claude.modes(),
      none: [],
    },
    {
      name: "an effort change",
      act: (session) => session.setEffort("low"),
      reached: (claude) => claude.efforts(),
      none: [],
    },
  ])("refuses $name after close and never calls Claude", async ({
    act,
    reached,
    none,
  }) => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    session.close();
    const refused = await act(session);

    expect(refused.isErr() && refused.error._tag).toBe("ClaudeSessionClosed");
    expect(await reached(claude)).toEqual(none);
  });
});

describe("loadEffortSettings", () => {
  test("reads the effort level from the user's settings alone", async () => {
    const asked: SettingSource[][] = [];

    const loaded = await loadEffortSettings("/work/tree", {
      resolveSettings: async ({ settingSources }) => {
        asked.push(settingSources);
        return { effective: { effortLevel: "xhigh" } };
      },
    });

    expect(loaded.isOk() && loaded.value.effortLevel).toBe("xhigh");
    expect(asked).toEqual([["user"]]);
  });
});

describe("loadClaudeModels", () => {
  test("lists the models Claude Code offers without sending a prompt and closes Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      models: [SONNET_INFO],
    });

    const loaded = await loadClaudeModels(claude.runtime, "/work/tree");

    expect(loaded.isOk() && loaded.value.map(({ id }) => id)).toEqual([
      "claude-sonnet-5-5",
    ]);
    expect(await claude.prompts()).toEqual([]);
    expect(claude.closes()).toBe(1);
  });

  test("starts Claude without the variables that would bill the API", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-fixture" },
    });

    await loadClaudeModels(claude.runtime, "/work/tree");

    expect(claude.options().env).toEqual({ PATH: "/usr/bin" });
  });

  test("refuses to list when the user's settings would switch the login", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      settingsEnv: { ANTHROPIC_API_KEY: "api-key" },
      models: [SONNET_INFO],
    });

    const loaded = await loadClaudeModels(claude.runtime, "/work/tree");

    expect(loaded.isErr() && loaded.error._tag).toBe(
      "ClaudeSettingsOverrideAuth",
    );
    expect(claude.started()).toBe(false);
  });

  test("gives up on a Claude Code that never lists and closes it", async () => {
    const claude = fakeClaude(SUBSCRIPTION, { models: "unanswered" });

    const loaded = await loadClaudeModels(claude.runtime, "/work/tree", 10);

    expect(loaded.isErr() && loaded.error._tag).toBe("ClaudeModelsUnavailable");
    expect(claude.closes()).toBe(1);
  });

  test("reports a list without a Claude model as a failure", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      models: [
        { value: "custom", displayName: "Custom", description: "Custom model" },
      ],
    });

    const loaded = await loadClaudeModels(claude.runtime, "/work/tree");

    expect(loaded.isErr() && loaded.error._tag).toBe("NoClaudeModelsListed");
  });

  test("reports a list Claude cannot give and still closes Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      models: new Error("no control channel"),
    });

    const loaded = await loadClaudeModels(claude.runtime, "/work/tree");

    expect(loaded.isErr() && loaded.error._tag).toBe("ClaudeModelsUnavailable");
    expect(claude.closes()).toBe(1);
  });
});

describe("readClaudeLogin", () => {
  test("reports the subscription without sending a prompt and closes Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);

    const login = await readClaudeLogin(claude.runtime, "/work/tree");

    expect(login.isOk() && login.value).toBe("Claude Max");
    expect(await claude.prompts()).toEqual([]);
    expect(claude.closes()).toBe(1);
  });

  test("refuses a login that would bill the API and still closes Claude", async () => {
    const claude = fakeClaude({ apiProvider: "bedrock" });

    const login = await readClaudeLogin(claude.runtime, "/work/tree");

    expect(login.isErr() && login.error._tag).toBe("ClaudeNotSubscription");
    expect(claude.closes()).toBe(1);
  });

  test("gives up on a Claude Code that never answers and closes it", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      accountAnswered: new Promise(() => {}),
    });

    const login = await readClaudeLogin(claude.runtime, "/work/tree", 10);

    expect(login.isErr() && login.error._tag).toBe("ClaudeAccountUnavailable");
    expect(claude.closes()).toBe(1);
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
    unlistableProject(configDir);

    const found = await claudeSessionExists("se-1", configDir);

    expect(found.isErr() && found.error._tag).toBe("FileReadFailed");
  });
});

describe("readClaudeSubagents", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "harnexus-claude-config-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("reads each agent's note and messages from beside the conversation's record", async () => {
    const folder = subagentFolder(configDir);
    writeAgent(folder, "a1", {
      agentType: "Explore",
      description: "read the README",
      name: "reader",
      toolUseId: "toolu-1",
      spawnDepth: 1,
    });
    writeAgent(folder, "a2", "not json");
    writeFileSync(join(folder, "agent-a3.meta.json"), "{}");
    const asked: string[] = [];

    const read = await readClaudeSubagents(SESSION_ID, {
      read: async (sessionId, agentId) => {
        asked.push(`${sessionId}/${agentId}`);
        return [];
      },
      configDir,
    });

    expect(read.isOk() && read.value).toEqual([
      {
        agentId: "a1",
        toolUseId: "toolu-1",
        description: "read the README",
        agentType: "Explore",
        name: "reader",
        depth: 1,
        messages: [],
      },
    ]);
    expect(asked).toEqual([`${SESSION_ID}/a1`]);
  });

  // Claude can keep an agent's record in a folder of its own below the conversation's agents, where the SDK's reader finds it by its id.
  test("reads an agent Claude recorded in a folder below the others through the SDK's reader", async () => {
    const nested = join(subagentFolder(configDir), "workflows", "run-1");
    writeAgent(
      nested,
      "a7",
      { agentType: "Explore", toolUseId: "toolu-7", spawnDepth: 1 },
      [
        JSON.stringify({
          type: "user",
          uuid: "00000000-0000-4000-8000-000000000007",
          parentUuid: null,
          sessionId: SESSION_ID,
          agentId: "a7",
          isSidechain: true,
          cwd: "/work/tree",
          timestamp: "2026-09-27T00:00:01.000Z",
          message: { role: "user", content: "look around" },
        }),
      ],
    );

    const read = await withConfigDir(configDir, () =>
      readClaudeSubagents(SESSION_ID, { configDir }),
    );

    expect(read.isOk() && read.value).toMatchObject([
      {
        agentId: "a7",
        toolUseId: "toolu-7",
        messages: [
          {
            type: "user",
            parent_tool_use_id: "toolu-7",
            message: { content: "look around" },
          },
        ],
      },
    ]);
  });

  test("leaves out an agent whose messages cannot be read and keeps the others", async () => {
    const folder = subagentFolder(configDir);
    for (const agentId of ["a1", "a2"]) {
      writeAgent(folder, agentId, {
        toolUseId: `toolu-${agentId}`,
        spawnDepth: 1,
      });
    }

    const read = await readClaudeSubagents(SESSION_ID, {
      read: async (_sessionId, agentId) => {
        // biome-ignore lint/plugin/no-throw-try-catch: getSubagentMessages rejects when the record cannot be read.
        if (agentId === "a1") throw new Error("unreadable");
        return [];
      },
      configDir,
    });

    expect(read.isOk() && read.value.map((agent) => agent.agentId)).toEqual([
      "a2",
    ]);
  });

  test("reads no agent for a conversation without a record", async () => {
    mkdirSync(join(configDir, "projects", "-work-tree"), { recursive: true });

    const read = await readClaudeSubagents("se-1", {
      read: async () => [],
      configDir,
    });

    expect(read.isOk() && read.value).toEqual([]);
  });
});

describe("readClaudeSession", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "harnexus-claude-config-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  // The SDK's own reader finds the record through CLAUDE_CONFIG_DIR and answers one it cannot read with no messages.
  test.each([
    {
      name: "a readable record",
      prepare: (record: string) => chmodSync(record, 0o600),
      expected: "ok:1",
    },
    {
      name: "a record the bridge cannot read",
      prepare: unreadableRecord,
      expected: "err:ClaudeRecordUnreadable",
    },
  ])("reports $name through the SDK's reader as $expected", async ({
    prepare,
    expected,
  }) => {
    const record = writeRecord(configDir, SESSION_ID, RECORD_LINE);
    prepare(record);

    const read = await withConfigDir(configDir, () =>
      readClaudeSession(SESSION_ID, { configDir }),
    );

    expect(
      read.isOk() ? `ok:${read.value.length}` : `err:${read.error._tag}`,
    ).toBe(expected);
  });

  test("reports a missing record as an empty conversation", async () => {
    mkdirSync(join(configDir, "projects", "-work-tree"), { recursive: true });

    const read = await readClaudeSession("se-1", {
      read: async () => [],
      configDir,
    });

    expect(read.isOk() && read.value).toEqual([]);
  });

  test("reports an empty answer as unreadable when a project folder cannot be listed", async () => {
    unlistableProject(configDir);

    const read = await readClaudeSession("se-1", {
      read: async () => [],
      configDir,
    });

    expect(read.isErr() && read.error._tag).toBe("ClaudeRecordUnreadable");
  });

  test("reports a reader that fails as unreadable", async () => {
    const read = await readClaudeSession("se-1", {
      read: async () => {
        // biome-ignore lint/plugin/no-throw-try-catch: getSessionMessages rejects when it cannot read at all.
        throw new Error("unreadable");
      },
      configDir,
    });

    expect(read.isErr() && read.error._tag).toBe("ClaudeRecordUnreadable");
  });
});

const SETTINGS: ClaudeSessionSettings = {
  threadId: "th-fixture",
  cwd: "/work/tree",
  model: "claude-sonnet-5",
  connection: SUBSCRIPTION_CONNECTION,
  permissionMode: "auto",
  canUseTool: async () => ({ behavior: "deny", message: "not in this test" }),
};

const VERTEX: VertexConnection = {
  provider: "vertex",
  projectId: "sidework-project",
  region: "global",
  env: {
    CLAUDE_CODE_USE_VERTEX: "1",
    ANTHROPIC_VERTEX_PROJECT_ID: "sidework-project",
    CLOUD_ML_REGION: "global",
  },
};

const VERTEX_SETTINGS: ClaudeSessionSettings = {
  ...SETTINGS,
  connection: VERTEX,
};

const SUBSCRIPTION: AccountInfo = {
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};

const writeUserSettings = (dir: string, env: Record<string, string>) =>
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ env }));

type StartedSession = Awaited<ReturnType<typeof startedSession>>;

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

const writeRecord = (configDir: string, sessionId: string, line: string) => {
  const project = join(configDir, "projects", "-work-tree");
  mkdirSync(project, { recursive: true });
  const record = join(project, `${sessionId}.jsonl`);
  writeFileSync(record, `${line}\n`);
  return record;
};

const subagentFolder = (configDir: string) => {
  const record = writeRecord(configDir, SESSION_ID, RECORD_LINE);
  return join(record.slice(0, -".jsonl".length), "subagents");
};

// Claude writes an agent's messages and, beside them, the note of the call that started it.
const writeAgent = (
  folder: string,
  agentId: string,
  note: object | string,
  lines: readonly string[] = [],
) => {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `agent-${agentId}.meta.json`),
    typeof note === "string" ? note : JSON.stringify(note),
  );
  writeFileSync(
    join(folder, `agent-${agentId}.jsonl`),
    lines.map((line) => `${line}\n`).join(""),
  );
};

// A link to itself cannot be followed, as a folder or file without permission cannot, and unlike chmod it fails for root too and leaves the test directory removable.
const unlistableProject = (configDir: string) => {
  const project = join(configDir, "projects", "-work-tree");
  mkdirSync(join(configDir, "projects"), { recursive: true });
  symlinkSync(project, project);
};

const unreadableRecord = (record: string) => {
  rmSync(record);
  symlinkSync(record, record);
};

const withConfigDir = async <T>(configDir: string, run: () => Promise<T>) => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
};

// getSessionMessages only looks up session ids shaped as UUIDs.
const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";

const RECORD_LINE = JSON.stringify({
  type: "user",
  uuid: "00000000-0000-4000-8000-000000000001",
  parentUuid: null,
  sessionId: SESSION_ID,
  isSidechain: false,
  cwd: "/work/tree",
  timestamp: "2026-09-27T00:00:00.000Z",
  message: { role: "user", content: "hello" },
});

const SONNET_INFO = {
  value: "sonnet",
  resolvedModel: "claude-sonnet-5-5",
  displayName: "Sonnet",
  description: "Sonnet 5.5 · Efficient for routine tasks",
};
