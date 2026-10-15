import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import { Result, TaggedError } from "better-result";

class ClaudeNotSubscription extends TaggedError("ClaudeNotSubscription")<{
  apiProvider: string | null;
  apiKeySource: string | null;
  message: string;
}> {}

class ClaudeSettingsOverrideAuth extends TaggedError(
  "ClaudeSettingsOverrideAuth",
)<{
  names: string[];
  message: string;
}> {}

export type Env = Record<string, string | undefined>;

// Removing these keeps Claude Code on the claude.ai login; checkSubscription still rejects a key the CLI finds elsewhere, such as an apiKeyHelper.
export const withoutApiBilling = (env: Env): Env => {
  const kept = Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !API_BILLING_ENV.has(name) && name !== CUSTOM_HEADERS_ENV,
    ),
  );
  const headers = withoutAuthHeaders(env[CUSTOM_HEADERS_ENV] ?? "");
  return headers === "" ? kept : { ...kept, [CUSTOM_HEADERS_ENV]: headers };
};

// The CLI copies the settings env into its own environment after launch, so a billing variable or an auth header found there is refused rather than removed; accountInfo does not report a header that replaces the OAuth token.
export const checkSettingsEnv = (env: Record<string, string>) => {
  const names = Object.keys(env).filter(
    (name) =>
      API_BILLING_ENV.has(name) ||
      (name === CUSTOM_HEADERS_ENV && hasAuthHeader(env[name] ?? "")),
  );
  if (names.length === 0) return Result.ok();
  return Result.err(
    new ClaudeSettingsOverrideAuth({
      names,
      message: `Claude settings must not set ${names.join(", ")}, which would bypass the subscription login`,
    }),
  );
};

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

const withoutAuthHeaders = (headers: string) =>
  headerLines(headers)
    .filter((line) => !isAuthHeader(line))
    .join("\n")
    .trim();

const hasAuthHeader = (headers: string) =>
  headerLines(headers).some(isAuthHeader);

// Split the way the CLI reads the variable: one "Name: value" per line.
const headerLines = (headers: string) => headers.split(/\n|\r\n/);

const isAuthHeader = (line: string) => AUTH_HEADERS.has(headerName(line));

const headerName = (line: string) => {
  const colon = line.indexOf(":");
  return colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
};

const CUSTOM_HEADERS_ENV = "ANTHROPIC_CUSTOM_HEADERS";

const AUTH_HEADERS = new Set(["authorization", "x-api-key"]);

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
