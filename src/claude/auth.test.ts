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
  test("accepts a first-party subscription login", () => {
    expect(
      checkSubscription({
        subscriptionType: "Claude Max",
        apiProvider: "firstParty",
      }).isOk(),
    ).toBe(true);
  });

  test("accepts a login that reports no API key", () => {
    expect(
      checkSubscription({
        subscriptionType: "Claude Pro",
        apiProvider: "firstParty",
        apiKeySource: "none",
      }).isOk(),
    ).toBe(true);
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

  test("rejects a cloud provider or a gateway", () => {
    expect(checkSubscription({ apiProvider: "vertex" }).isErr()).toBe(true);
    expect(
      checkSubscription({
        subscriptionType: "Claude Max",
        apiProvider: "gateway",
      }).isErr(),
    ).toBe(true);
  });

  test("rejects an account that reports no provider", () => {
    expect(checkSubscription({ subscriptionType: "Claude Max" }).isErr()).toBe(
      true,
    );
  });
});
