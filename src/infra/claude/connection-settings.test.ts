import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnectionResolver,
  readConnectionSettings,
} from "./connection-settings.ts";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "harnexus-connections-")));
  path = join(dir, "connections.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createConnectionResolver", () => {
  test("leaves every repository on the subscription without a settings file", async () => {
    const resolve = createConnectionResolver({
      path,
      repositoryOf: noRepository,
    });

    const connection = await resolve("/work/side");

    expect(connection.isOk() && connection.value).toEqual({
      provider: "subscription",
    });
  });

  test.each([
    { name: "the repository itself", worktree: "/work/side" },
    { name: "a folder inside it", worktree: "/work/side/packages/app" },
  ])("gives $name the repository's Vertex connection", async ({ worktree }) => {
    await writeSettings({ "/work/side": VERTEX_ENTRY });
    const resolve = createConnectionResolver({
      path,
      repositoryOf: noRepository,
    });

    const connection = await resolve(worktree);

    expect(connection.isOk() && connection.value).toEqual(VERTEX);
  });

  test("leaves a repository whose path only starts like a configured one on the subscription", async () => {
    await writeSettings({ "/work/side": VERTEX_ENTRY });
    const resolve = createConnectionResolver({
      path,
      repositoryOf: noRepository,
    });

    const connection = await resolve("/work/side-other");

    expect(connection.isOk() && connection.value).toEqual({
      provider: "subscription",
    });
  });

  test("gives a worktree outside the repository the repository's connection", async () => {
    await writeSettings({ "/work/side": VERTEX_ENTRY });
    const resolve = createConnectionResolver({
      path,
      repositoryOf: async () => "/work/side",
    });

    const connection = await resolve("/codex/worktrees/b378/side");

    expect(connection.isOk() && connection.value).toEqual(VERTEX);
  });

  test("lets a folder inside a Vertex repository keep the subscription", async () => {
    await writeSettings({
      "/work/side": VERTEX_ENTRY,
      "/work/side/docs": { provider: "subscription" },
    });
    const resolve = createConnectionResolver({
      path,
      repositoryOf: noRepository,
    });

    const connection = await resolve("/work/side/docs");

    expect(connection.isOk() && connection.value).toEqual({
      provider: "subscription",
    });
  });

  test("reads an edited file on the next call", async () => {
    const resolve = createConnectionResolver({
      path,
      repositoryOf: noRepository,
    });
    const before = await resolve("/work/side");

    await writeSettings({ "/work/side": VERTEX_ENTRY });
    const after = await resolve("/work/side");

    expect(before.isOk() && before.value.provider).toBe("subscription");
    expect(after.isOk() && after.value.provider).toBe("vertex");
  });

  test("finds the repository a git worktree belongs to", async () => {
    const repository = join(dir, "side");
    const worktree = join(dir, "worktrees", "side");
    await mkdir(repository);
    for (const args of [
      ["init", "-q"],
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      ],
      ["worktree", "add", "-q", "--detach", worktree],
    ]) {
      expect(Bun.spawnSync(["git", "-C", repository, ...args]).exitCode).toBe(
        0,
      );
    }
    await writeSettings({ [repository]: VERTEX_ENTRY });
    const resolve = createConnectionResolver({ path });

    const connection = await resolve(worktree);

    expect(connection.isOk() && connection.value).toEqual(VERTEX);
  });

  test("stops on settings it cannot understand rather than using the subscription", async () => {
    await writeFile(path, "{");
    const resolve = createConnectionResolver({
      path,
      repositoryOf: noRepository,
    });

    const connection = await resolve("/work/side");

    expect(connection.isErr() && connection.error._tag).toBe(
      "ConnectionSettingsInvalid",
    );
  });
});

describe("readConnectionSettings", () => {
  test("reads a Vertex entry with its credentials file, model pins and model regions", async () => {
    await writeSettings({
      "/work/side/": {
        ...VERTEX_ENTRY,
        credentialsFile: "/keys/sidework.json",
        models: { opus: "claude-opus-5-5", haiku: "claude-haiku-4-5@20251001" },
        modelRegions: { VERTEX_REGION_CLAUDE_HAIKU_4_5: "us-east5" },
      },
    });

    const settings = await readConnectionSettings(path);

    expect(settings.isOk() && settings.value.get("/work/side")).toEqual({
      ...VERTEX,
      credentialsFile: "/keys/sidework.json",
      models: { opus: "claude-opus-5-5", haiku: "claude-haiku-4-5@20251001" },
      modelRegions: { VERTEX_REGION_CLAUDE_HAIKU_4_5: "us-east5" },
    });
  });

  test.each([
    { name: "is not JSON", content: "{", expected: "not valid JSON" },
    {
      name: "has a relative repository path",
      content: { repositories: { "work/side": VERTEX_ENTRY } },
      expected: "must be an absolute path",
    },
    {
      name: "has a misspelt key",
      content: {
        repositories: { "/work/side": { ...VERTEX_ENTRY, projectID: "x" } },
      },
      expected: "unknown key projectID",
    },
    {
      name: "has no project",
      content: {
        repositories: {
          "/work/side": { provider: "vertex", region: "global" },
        },
      },
      expected: "must set projectId",
    },
    {
      name: "has an unknown provider",
      content: { repositories: { "/work/side": { provider: "bedrock" } } },
      expected: 'provider to "vertex" or "subscription"',
    },
    {
      name: "pins an unknown alias",
      content: {
        repositories: {
          "/work/side": { ...VERTEX_ENTRY, models: { fable: "x" } },
        },
      },
      expected: "models must map opus, sonnet or haiku",
    },
    {
      name: "sets a region through another variable",
      content: {
        repositories: {
          "/work/side": {
            ...VERTEX_ENTRY,
            modelRegions: { CLOUD_ML_REGION: "us" },
          },
        },
      },
      expected: "modelRegions must map VERTEX_REGION_CLAUDE_*",
    },
    {
      name: "has a relative credentials file",
      content: {
        repositories: {
          "/work/side": { ...VERTEX_ENTRY, credentialsFile: "key.json" },
        },
      },
      expected: "credentialsFile must be an absolute path",
    },
  ])("refuses a file that $name", async ({ content, expected }) => {
    await writeFile(
      path,
      typeof content === "string" ? content : JSON.stringify(content),
    );

    const settings = await readConnectionSettings(path);

    expect(settings.isErr() && settings.error._tag).toBe(
      "ConnectionSettingsInvalid",
    );
    expect(settings.isErr() && settings.error.message).toContain(expected);
  });

  test("reports a settings path it cannot read", async () => {
    await mkdir(path);

    const settings = await readConnectionSettings(path);

    expect(settings.isErr() && settings.error._tag).toBe(
      "ConnectionSettingsUnreadable",
    );
  });
});

const writeSettings = (repositories: Record<string, unknown>) =>
  writeFile(path, JSON.stringify({ repositories }));

const noRepository = async () => null;

const VERTEX_ENTRY = {
  provider: "vertex",
  projectId: "sidework-project",
  region: "global",
} as const;

const VERTEX = {
  provider: "vertex",
  projectId: "sidework-project",
  region: "global",
  credentialsFile: null,
  models: {},
  modelRegions: {},
} as const;
