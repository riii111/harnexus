import { describe, expect, test } from "bun:test";
import { checkSubscription, withoutApiBilling } from "./auth.ts";

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
