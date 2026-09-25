import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import { Result, TaggedError } from "better-result";

class ClaudeNotSubscription extends TaggedError("ClaudeNotSubscription")<{
  apiProvider: string | null;
  apiKeySource: string | null;
  message: string;
}> {}

export type Env = Record<string, string | undefined>;

// Removing these keeps Claude Code on the claude.ai login; checkSubscription still rejects a key the CLI finds elsewhere, such as an apiKeyHelper.
export const withoutApiBilling = (env: Env): Env =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => !API_BILLING_ENV.has(name)),
  );

// The CLI reports a subscription even while an API key is in use, so the key source decides who is billed; a setup-token login reports its token source instead of the subscription.
export const checkSubscription = (account: AccountInfo) => {
  const apiKeySource = account.apiKeySource ?? "none";
  const subscribed =
    (account.subscriptionType ?? "") !== "" ||
    SUBSCRIPTION_TOKEN_SOURCES.has(account.tokenSource ?? "");
  if (
    account.apiProvider === "firstParty" &&
    subscribed &&
    apiKeySource === "none"
  ) {
    return Result.ok();
  }
  return Result.err(
    new ClaudeNotSubscription({
      apiProvider: account.apiProvider ?? null,
      apiKeySource: account.apiKeySource ?? null,
      message:
        "Claude must use a claude.ai subscription login, not an API key or a cloud provider",
    }),
  );
};

const SUBSCRIPTION_TOKEN_SOURCES = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
]);

const API_BILLING_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_GATEWAY",
]);
