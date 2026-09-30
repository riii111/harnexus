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
import type { Result } from "better-result";
import {
  type ClaudeSessionSettings,
  claudeSessionExists,
  loadClaudeModels,
  loadEffortSettings,
  readClaudeLogin,
  readClaudeSession,
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
      act: async (session) => session.send("late"),
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

  test("switches Claude's permission mode", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    const switched = await session.setPermissionMode("plan");

    expect(switched.isOk()).toBe(true);
    expect(claude.modes()).toEqual(["plan"]);
  });

  test("sets Claude's effort through the session flag settings", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const session = await startedSession(claude);

    const switched = await session.setEffort("max");

    expect(switched.isOk()).toBe(true);
    expect(claude.efforts()).toEqual(["max"]);
  });

  test("reports an effort Claude refuses as its own failure", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      effortError: new Error("no control channel"),
    });
    const session = await startedSession(claude);

    const switched = await session.setEffort("high");

    expect(switched.isErr() && switched.error._tag).toBe("ClaudeEffortFailed");
  });
});

describe("loadEffortSettings", () => {
  test("reads the effort level in the user's settings", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      effortSettings: { effortLevel: "xhigh" },
    });

    const loaded = await loadEffortSettings("/work/tree", claude.runtime);

    expect(loaded.isOk() && loaded.value.effortLevel).toBe("xhigh");
  });

  test("reports settings it cannot read", async () => {
    const claude = fakeClaude(SUBSCRIPTION, {
      settingsEnv: new Error("invalid settings"),
    });

    const loaded = await loadEffortSettings("/work/tree", claude.runtime);

    expect(loaded.isErr() && loaded.error._tag).toBe(
      "ClaudeSettingsUnavailable",
    );
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
