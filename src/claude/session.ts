import {
  type CanUseTool,
  type McpServerConfig,
  type Options,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Result, TaggedError } from "better-result";
import {
  type ClaudeQuery,
  type ClaudeStreamFailed,
  closeQuery,
  interruptQuery,
  nextMessage,
  openQuery,
  type RunQuery,
  readAccount,
} from "../boundary/claude-sdk.ts";
import { checkSubscription, type Env, withoutApiBilling } from "./auth.ts";
import { createInputQueue } from "./input.ts";

export type ClaudeSessionSettings = {
  cwd: string;
  model: string;
  env: Env;
  resume?: string;
  mcpServers?: Record<string, McpServerConfig>;
};

class ClaudeSessionClosed extends TaggedError("ClaudeSessionClosed")<{
  message: string;
}> {}

// The account is checked before any prompt is sent, so a login that would bill the API never starts a conversation.
export const startClaudeSession = async (
  settings: ClaudeSessionSettings,
  run: RunQuery = query,
) => {
  const input = createInputQueue();
  const opened = openQuery(run, input.stream, sessionOptions(settings));
  if (opened.isErr()) return Result.err(opened.error);
  const claude = opened.value;
  const checked = (await readAccount(claude)).andThen(checkSubscription);
  if (checked.isErr()) {
    input.end();
    closeQuery(claude);
    return Result.err(checked.error);
  }
  return Result.ok(createSession(claude, input));
};

// Only the prompt text reaches Claude; Codex instructions and the app's history stay out of the preset system prompt.
const sessionOptions = (settings: ClaudeSessionSettings): Options => ({
  cwd: settings.cwd,
  model: settings.model,
  env: withoutApiBilling(settings.env),
  settingSources: ["user", "project", "local"],
  systemPrompt: { type: "preset", preset: "claude_code" },
  // A user's default mode such as bypassPermissions would skip canUseTool, which is the only approval surface so far.
  permissionMode: "default",
  canUseTool: denyAllTools,
  includePartialMessages: true,
  mcpServers: settings.mcpServers ?? {},
  ...(settings.resume === undefined ? {} : { resume: settings.resume }),
});

const createSession = (
  claude: ClaudeQuery,
  input: ReturnType<typeof createInputQueue>,
) => {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    input.end();
    closeQuery(claude);
  };
  return {
    messages: readMessages(claude, () => closed, close),
    send: (text: string) => {
      const uuid = closed ? null : input.push(text);
      return uuid === null ? Result.err(sessionClosed()) : Result.ok(uuid);
    },
    interrupt: async () =>
      closed ? Result.err(sessionClosed()) : interruptQuery(claude),
    close,
  };
};

async function* readMessages(
  claude: ClaudeQuery,
  isClosed: () => boolean,
  close: () => void,
): AsyncGenerator<Result<SDKMessage, ClaudeStreamFailed>, void> {
  // A consumer that stops reading early still stops Claude, since nobody would see its output.
  try {
    while (!isClosed()) {
      const next = await nextMessage(claude);
      // A read pending across close ends or fails depending on the SDK cleanup, and either is the end of the stream.
      if (isClosed()) return;
      if (next.isErr()) {
        // Closed before the consumer sees the failure, so a send made while handling it is refused rather than lost.
        close();
        yield Result.err(next.error);
        return;
      }
      if (next.value.done === true) return;
      yield Result.ok(next.value.value);
    }
  } finally {
    close();
  }
}

// TODO: replace with the approval relay to the app in P9.
const denyAllTools: CanUseTool = async (toolName) => ({
  behavior: "deny",
  message: `${toolName} needs approval, and this session cannot ask for it yet`,
});

const sessionClosed = () =>
  new ClaudeSessionClosed({ message: "the Claude session is closed" });
