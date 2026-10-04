import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnectionResolver } from "./connection-settings.ts";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "harnexus-connections-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createConnectionResolver", () => {
  test("leaves a repository without Vertex in its Claude Code settings on the subscription", async () => {
    await writeSettings(dir, "settings.json", { env: { FOO: "bar" } });
    const resolve = createConnectionResolver({ repositoryOf: noRepository });

    const connection = await resolve(dir);

    expect(connection.isOk() && connection.value).toEqual({
      provider: "subscription",
    });
  });

  test.each([
    { name: "local", file: "settings.local.json" },
    { name: "shared", file: "settings.json" },
  ])("takes Vertex from the repository's $name Claude Code settings", async ({
    file,
  }) => {
    await writeSettings(dir, file, { env: VERTEX_ENV });
    const resolve = createConnectionResolver({ repositoryOf: noRepository });

    const connection = await resolve(dir);

    expect(connection.isOk() && connection.value).toEqual(VERTEX);
  });

  test("passes Claude only the Vertex variables, model pins and credentials file of the settings", async () => {
    await writeSettings(dir, "settings.local.json", {
      env: {
        ...VERTEX_ENV,
        GOOGLE_APPLICATION_CREDENTIALS: "/keys/sidework.json",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5@20251001",
        VERTEX_REGION_CLAUDE_HAIKU_4_5: "us-east5",
        LINEAR_API_KEY: "fixture-key",
      },
    });
    const resolve = createConnectionResolver({ repositoryOf: noRepository });

    const connection = await resolve(dir);

    expect(connection.isOk() && connection.value).toEqual({
      ...VERTEX,
      env: {
        ...VERTEX_ENV,
        GOOGLE_APPLICATION_CREDENTIALS: "/keys/sidework.json",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5@20251001",
        VERTEX_REGION_CLAUDE_HAIKU_4_5: "us-east5",
      },
    });
  });

  test("leaves a repository whose settings turn Vertex off on the subscription", async () => {
    await writeSettings(dir, "settings.local.json", {
      env: { ...VERTEX_ENV, CLAUDE_CODE_USE_VERTEX: "0" },
    });
    const resolve = createConnectionResolver({ repositoryOf: noRepository });

    const connection = await resolve(dir);

    expect(connection.isOk() && connection.value).toEqual({
      provider: "subscription",
    });
  });

  test("gives a git worktree without the untracked settings its repository's connection", async () => {
    const repository = join(dir, "side");
    const worktree = join(dir, "worktrees", "side");
    await mkdir(repository);
    for (const args of [
      ["init", "-q"],
      [...AUTHOR, "commit", "-q", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-q", "--detach", worktree],
    ]) {
      expect(Bun.spawnSync(["git", "-C", repository, ...args]).exitCode).toBe(
        0,
      );
    }
    await writeSettings(repository, "settings.local.json", { env: VERTEX_ENV });
    const resolve = createConnectionResolver();

    const connection = await resolve(worktree);

    expect(connection.isOk() && connection.value).toEqual(VERTEX);
  });

  test("completes a worktree's shared Vertex settings with the repository's local ones", async () => {
    const repository = join(dir, "side");
    const worktree = join(dir, "worktrees", "side");
    await mkdir(repository);
    await writeSettings(repository, "settings.json", {
      env: { CLAUDE_CODE_USE_VERTEX: "1" },
    });
    for (const args of [
      ["init", "-q"],
      ["add", ".claude/settings.json"],
      [...AUTHOR, "commit", "-q", "-m", "init"],
      ["worktree", "add", "-q", "--detach", worktree],
    ]) {
      expect(Bun.spawnSync(["git", "-C", repository, ...args]).exitCode).toBe(
        0,
      );
    }
    await writeSettings(repository, "settings.local.json", {
      env: {
        ANTHROPIC_VERTEX_PROJECT_ID: "sidework-project",
        CLOUD_ML_REGION: "global",
      },
    });
    const resolve = createConnectionResolver();

    const connection = await resolve(worktree);

    expect(connection.isOk() && connection.value).toEqual(VERTEX);
  });

  test.each([
    { name: "not JSON", content: "{" },
    { name: "not an object", content: "[]" },
  ])("stops on a settings file that is $name rather than using the subscription", async ({
    content,
  }) => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.local.json"), content);
    const resolve = createConnectionResolver({ repositoryOf: noRepository });

    const connection = await resolve(dir);

    expect(connection.isErr() && connection.error._tag).toBe(
      "RepositorySettingsUnreadable",
    );
  });

  test("reads an edited settings file on the next call", async () => {
    const resolve = createConnectionResolver({ repositoryOf: noRepository });
    const before = await resolve(dir);

    await writeSettings(dir, "settings.local.json", { env: VERTEX_ENV });
    const after = await resolve(dir);

    expect(before.isOk() && before.value.provider).toBe("subscription");
    expect(after.isOk() && after.value.provider).toBe("vertex");
  });

  test.each([
    {
      name: "a project",
      env: { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "global" },
      expected: "VertexSettingsIncomplete",
    },
    {
      name: "a region",
      env: {
        CLAUDE_CODE_USE_VERTEX: "1",
        ANTHROPIC_VERTEX_PROJECT_ID: "sidework-project",
      },
      expected: "VertexSettingsIncomplete",
    },
  ])("stops on Vertex settings without $name rather than using the subscription", async ({
    env,
    expected,
  }) => {
    await writeSettings(dir, "settings.local.json", { env });
    const resolve = createConnectionResolver({ repositoryOf: noRepository });

    const connection = await resolve(dir);

    expect(connection.isErr() && connection.error._tag).toBe(expected);
  });

  test("stops on Vertex settings that route through a gateway", async () => {
    await writeSettings(dir, "settings.local.json", {
      env: { ...VERTEX_ENV, ANTHROPIC_VERTEX_BASE_URL: "https://gw.example" },
    });
    const resolve = createConnectionResolver({ repositoryOf: noRepository });

    const connection = await resolve(dir);

    expect(connection.isErr() && connection.error._tag).toBe(
      "VertexGatewayUnsupported",
    );
  });

  test("stops when the settings cannot be read rather than using the subscription", async () => {
    const resolve = createConnectionResolver({
      resolve: async () => {
        // biome-ignore lint/plugin/no-throw-try-catch: fakes the Claude SDK, which reports failures by throwing.
        throw new Error("unreadable");
      },
      repositoryOf: noRepository,
    });

    const connection = await resolve(dir);

    expect(connection.isErr() && connection.error._tag).toBe(
      "ClaudeSettingsUnavailable",
    );
  });
});

const writeSettings = async (root: string, file: string, content: object) => {
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(join(root, ".claude", file), JSON.stringify(content));
};

const noRepository = async () => null;

const AUTHOR = ["-c", "user.name=t", "-c", "user.email=t@example.com"];

const VERTEX_ENV = {
  CLAUDE_CODE_USE_VERTEX: "1",
  ANTHROPIC_VERTEX_PROJECT_ID: "sidework-project",
  CLOUD_ML_REGION: "global",
};

const VERTEX = {
  provider: "vertex",
  projectId: "sidework-project",
  region: "global",
  env: VERTEX_ENV,
} as const;
