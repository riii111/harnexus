import { describe, expect, test } from "bun:test";
import {
  checkAccount,
  checkSettingsEnv,
  checkSubscription,
  connectionEnv,
  withoutApiBilling,
} from "./auth.ts";
import {
  SUBSCRIPTION_CONNECTION,
  type VertexConnection,
} from "./connection.ts";

describe("withoutApiBilling", () => {
  test("drops API keys and provider switches and keeps the rest", () => {
    const env = withoutApiBilling({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/home/user/.claude",
      ANTHROPIC_API_KEY: "api-key",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_GATEWAY: "1",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/home/user/.claude",
    });
  });

  test.each([
    {
      name: "a mix of auth headers and others",
      env: {
        ANTHROPIC_CUSTOM_HEADERS:
          "Authorization: Bearer other\r\nX-Trace: 1\nx-api-key: key",
      },
      expected: { ANTHROPIC_CUSTOM_HEADERS: "X-Trace: 1" },
    },
    {
      name: "only auth headers",
      env: {
        PATH: "/usr/bin",
        ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer other",
      },
      expected: { PATH: "/usr/bin" },
    },
  ])("keeps only the custom headers that cannot replace the login for $name", ({
    env,
    expected,
  }) => {
    expect(withoutApiBilling(env)).toEqual(expected);
  });
});

describe("connectionEnv", () => {
  test("sets the repository's Vertex project, region, credentials and model pins over the inherited ones", () => {
    const env = connectionEnv(
      {
        ...VERTEX,
        env: {
          ...VERTEX.env,
          GOOGLE_APPLICATION_CREDENTIALS: "/keys/sidework.json",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5@20251001",
          VERTEX_REGION_CLAUDE_HAIKU_4_5: "us-east5",
        },
      },
      {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "api-key",
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_VERTEX_PROJECT_ID: "other-project",
        CLOUD_ML_REGION: "europe-west1",
        ANTHROPIC_VERTEX_BASE_URL: "https://gateway.example",
        CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
        VERTEX_REGION_CLAUDE_5_SONNET: "europe-west1",
        GOOGLE_APPLICATION_CREDENTIALS: "/keys/other.json",
      },
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "sidework-project",
      CLOUD_ML_REGION: "global",
      GOOGLE_APPLICATION_CREDENTIALS: "/keys/sidework.json",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5@20251001",
      VERTEX_REGION_CLAUDE_HAIKU_4_5: "us-east5",
    });
  });

  test("leaves the subscription without any provider switch", () => {
    const env = connectionEnv(SUBSCRIPTION_CONNECTION, {
      PATH: "/usr/bin",
      CLAUDE_CODE_USE_VERTEX: "1",
    });

    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("checkSettingsEnv", () => {
  test.each([
    { name: "project", env: { ANTHROPIC_VERTEX_PROJECT_ID: "other-project" } },
    { name: "region", env: { CLOUD_ML_REGION: "us-east5" } },
    { name: "model region", env: { VERTEX_REGION_CLAUDE_5_OPUS: "us-east5" } },
    { name: "gateway", env: { ANTHROPIC_VERTEX_BASE_URL: "https://gw" } },
    { name: "API key", env: { ANTHROPIC_API_KEY: "api-key" } },
  ])("refuses Claude settings that set another Vertex $name", ({ env }) => {
    const checked = checkSettingsEnv(env, VERTEX);

    expect(checked.isErr() && checked.error._tag).toBe(
      "ClaudeSettingsOverrideAuth",
    );
  });

  test("accepts Claude settings that repeat the repository's Vertex settings", () => {
    const checked = checkSettingsEnv(VERTEX.env, VERTEX);

    expect(checked.isOk()).toBe(true);
  });

  test("refuses a model pin in Claude settings only when the repository's connection pins it differently", () => {
    const pinned = checkSettingsEnv(
      { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8" },
      {
        ...VERTEX,
        env: { ...VERTEX.env, ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5" },
      },
    );
    const unpinned = checkSettingsEnv(
      { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8" },
      VERTEX,
    );

    expect(pinned.isErr() && pinned.error.names).toEqual([
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ]);
    expect(unpinned.isOk()).toBe(true);
  });

  test("accepts Vertex variables other than the provider switch on the subscription", () => {
    const checked = checkSettingsEnv(
      { ANTHROPIC_VERTEX_PROJECT_ID: "other-project" },
      SUBSCRIPTION_CONNECTION,
    );

    expect(checked.isOk()).toBe(true);
  });
});

describe("checkAccount", () => {
  test("accepts a Vertex connection when Claude Code reports Vertex", () => {
    expect(checkAccount({ apiProvider: "vertex" }, VERTEX).isOk()).toBe(true);
  });

  test.each([
    {
      name: "a subscription login",
      account: { subscriptionType: "Claude Max", apiProvider: "firstParty" },
    },
    { name: "another cloud provider", account: { apiProvider: "bedrock" } },
    { name: "no provider", account: {} },
  ] as const)("rejects $name on a Vertex connection", ({ account }) => {
    const checked = checkAccount(account, VERTEX);

    expect(checked.isErr() && checked.error._tag).toBe("ClaudeNotVertex");
  });

  test("rejects Vertex on the subscription", () => {
    const checked = checkAccount(
      { apiProvider: "vertex" },
      SUBSCRIPTION_CONNECTION,
    );

    expect(checked.isErr() && checked.error._tag).toBe("ClaudeNotSubscription");
  });
});

describe("checkSubscription", () => {
  test.each([
    {
      name: "a first-party subscription login",
      account: { subscriptionType: "Claude Max", apiProvider: "firstParty" },
    },
    {
      name: "a login that reports no API key",
      account: {
        subscriptionType: "Claude Pro",
        apiProvider: "firstParty",
        apiKeySource: "none",
      },
    },
    {
      name: "a setup-token login, which reports no subscription type",
      account: {
        apiProvider: "firstParty",
        tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
      },
    },
  ])("accepts $name", ({ account }) => {
    expect(checkSubscription(account).isOk()).toBe(true);
  });

  test.each([
    {
      name: "a bearer token that is not a subscription login",
      account: {
        apiProvider: "firstParty",
        tokenSource: "ANTHROPIC_AUTH_TOKEN",
      },
    },
    {
      name: "a gateway",
      account: { subscriptionType: "Claude Max", apiProvider: "gateway" },
    },
    {
      name: "an account that reports no provider",
      account: { subscriptionType: "Claude Max" },
    },
  ])("rejects $name", ({ account }) => {
    const checked = checkSubscription(account);

    expect(checked.isErr() && checked.error._tag).toBe("ClaudeNotSubscription");
  });

  test("rejects an API key even when a subscription is logged in", () => {
    const checked = checkSubscription({
      subscriptionType: "Claude Max",
      apiProvider: "firstParty",
      apiKeySource: "/login managed key",
    });

    expect(checked.isErr() && checked.error.apiKeySource).toBe(
      "/login managed key",
    );
  });
});

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
