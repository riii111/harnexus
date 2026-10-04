import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import { Result, TaggedError } from "better-result";
import {
  type Connection,
  SUBSCRIPTION_CONNECTION,
  VERTEX_REGION_PREFIX,
  type VertexConnection,
} from "./connection.ts";

class ClaudeNotSubscription extends TaggedError("ClaudeNotSubscription")<{
  apiProvider: string | null;
  apiKeySource: string | null;
  message: string;
}> {}

class ClaudeNotVertex extends TaggedError("ClaudeNotVertex")<{
  apiProvider: string | null;
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

// A Vertex connection starts from the same environment, so no API key or other provider's switch reaches Claude Code alongside the values harnexus sets.
export const connectionEnv = (connection: Connection, env: Env): Env => {
  const kept = withoutApiBilling(env);
  if (connection.provider === "subscription") return kept;
  return {
    ...Object.fromEntries(
      Object.entries(kept).filter(([name]) => !isVertexEnv(name)),
    ),
    ...connection.env,
  };
};

// The CLI copies the settings env into its own environment after launch, so a billing variable or an auth header found there is refused rather than removed; accountInfo does not report a header that replaces the OAuth token.
// On Vertex the connection's variables reach Claude Code as flag settings, which outrank every settings file, so only another provider's variable is refused.
export const checkSettingsEnv = (
  env: Record<string, string>,
  connection: Connection = SUBSCRIPTION_CONNECTION,
) => {
  const names = Object.keys(env).filter((name) =>
    connection.provider === "vertex" && name in connection.env
      ? false
      : API_BILLING_ENV.has(name) ||
        (name === CUSTOM_HEADERS_ENV && hasAuthHeader(env[name] ?? "")) ||
        (connection.provider === "vertex" && isVertexEnv(name)),
  );
  if (names.length === 0) return Result.ok();
  return Result.err(
    new ClaudeSettingsOverrideAuth({
      names,
      message:
        connection.provider === "subscription"
          ? `Claude settings must not set ${names.join(", ")}, which would bypass the subscription login`
          : `Claude settings must not set ${names.join(", ")}, which this repository's Claude Code settings do not set for Google Vertex AI`,
    }),
  );
};

// Vertex in the user's settings would apply to every repository, so it is refused even when a repository's settings repeat it.
export const checkUserSettingsEnv = (env: Record<string, string>) => {
  const names = Object.keys(env).filter(
    (name) => API_BILLING_ENV.has(name) || isVertexEnv(name),
  );
  if (names.length === 0) return Result.ok();
  return Result.err(
    new ClaudeSettingsOverrideAuth({
      names,
      message: `Claude Code user settings must not set ${names.join(", ")}; set Google Vertex AI in each repository's Claude Code settings instead`,
    }),
  );
};

// Claude Code reports the provider from its configuration without asking Google Cloud, so this confirms where requests go, not that the credentials work.
export const checkAccount = (account: AccountInfo, connection: Connection) => {
  if (connection.provider === "subscription") return checkSubscription(account);
  if (account.apiProvider === "vertex") return Result.ok();
  return Result.err(
    new ClaudeNotVertex({
      apiProvider: account.apiProvider ?? null,
      message:
        "Claude Code did not report Google Vertex AI as its provider, so nothing was sent to Claude",
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

// The credentials file stays out, since the command is shown in the chat.
export const terminalEnv = (connection: VertexConnection) =>
  Object.entries(connection.env).filter(([name]) => name !== CREDENTIALS_ENV);

export const CREDENTIALS_ENV = "GOOGLE_APPLICATION_CREDENTIALS";

const isVertexEnv = (name: string) =>
  VERTEX_ENV.has(name) || name.startsWith(VERTEX_REGION_PREFIX);

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

// A base URL or skipped auth routes Vertex requests through a gateway, which harnexus does not offer.
const VERTEX_ENV = new Set([
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
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
