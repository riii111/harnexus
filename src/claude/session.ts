import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  query,
  resolveSettings,
  type SDKMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { Result, TaggedError } from "better-result";
import {
  type ClaudeQuery,
  type ClaudeSdk,
  type ClaudeStreamFailed,
  closeQuery,
  interruptQuery,
  nextMessage,
  openQuery,
  readAccount,
  readSettingsEnv,
  setQueryPermissionMode,
} from "../boundary/claude-sdk.ts";
import { listDirectoryIfExists } from "../boundary/fs.ts";
import {
  checkSettingsEnv,
  checkSubscription,
  type Env,
  withoutApiBilling,
} from "./auth.ts";
import { createPromptQueue } from "./prompt-queue.ts";

export type ClaudeSessionSettings = {
  cwd: string;
  model: string;
  resume?: string;
  mcpServers?: Record<string, McpServerConfig>;
  // Tools that run without asking, on top of the user's own allow rules.
  allowedTools?: string[];
  canUseTool: CanUseTool;
};

class ClaudeSessionClosed extends TaggedError("ClaudeSessionClosed")<{
  message: string;
}> {}

type ClaudeRuntime = ClaudeSdk & { env: Env };

// The settings and the account are checked before any prompt is sent, so a login that would bill the API never starts a conversation.
export const startClaudeSession = (
  settings: ClaudeSessionSettings,
  runtime: ClaudeRuntime = PROCESS_RUNTIME,
) =>
  Result.gen(async function* () {
    const settingsEnv = yield* Result.await(
      readSettingsEnv(runtime.resolveSettings, settings.cwd, SETTING_SOURCES),
    );
    yield* checkSettingsEnv(settingsEnv);
    const prompt = createPromptQueue();
    const claude = yield* openQuery(
      runtime.query,
      prompt.stream,
      sessionOptions(settings, runtime.env),
    );
    const checked = (await readAccount(claude)).andThen(checkSubscription);
    if (checked.isErr()) {
      prompt.end();
      closeQuery(claude);
    }
    yield* checked;
    return Result.ok(createSession(claude, prompt));
  });

// Claude keeps a conversation as <session id>.jsonl in a project folder under its config directory, which the user may delete or move to another machine.
// The SDK's lookup reports an unreadable record as missing, so absence is concluded only when every project folder could be listed without finding the file.
export const claudeSessionExists = (
  sessionId: string,
  configDir: string = claudeConfigDir(process.env),
) =>
  Result.gen(async function* () {
    const projectsDir = join(configDir, "projects");
    const projects = yield* Result.await(listDirectoryIfExists(projectsDir));
    const fileName = `${sessionId}.jsonl`;
    for (const project of projects ?? []) {
      if (!project.isDirectory) continue;
      const files = yield* Result.await(
        listDirectoryIfExists(join(projectsDir, project.name)),
      );
      if (files?.some((file) => file.name === fileName)) return Result.ok(true);
    }
    return Result.ok(false);
  });

// Codex instructions and the app's history are never appended to the preset system prompt.
const sessionOptions = (
  settings: ClaudeSessionSettings,
  env: Env,
): Options => ({
  cwd: settings.cwd,
  model: settings.model,
  env: withoutApiBilling(env),
  settingSources: SETTING_SOURCES,
  systemPrompt: { type: "preset", preset: "claude_code" },
  // A user's default mode such as bypassPermissions would skip canUseTool, which is how the app approves tools.
  permissionMode: "default",
  canUseTool: settings.canUseTool,
  includePartialMessages: true,
  mcpServers: settings.mcpServers ?? {},
  allowedTools: settings.allowedTools ?? [],
  ...(settings.resume === undefined ? {} : { resume: settings.resume }),
});

const createSession = (
  claude: ClaudeQuery,
  prompt: ReturnType<typeof createPromptQueue>,
) => {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    prompt.end();
    closeQuery(claude);
  };
  return {
    messages: readMessages(claude, () => closed, close),
    send: (text: string) => {
      const uuid = closed ? null : prompt.push(text);
      return uuid === null ? Result.err(sessionClosed()) : Result.ok(uuid);
    },
    interrupt: async () =>
      closed ? Result.err(sessionClosed()) : interruptQuery(claude),
    setPermissionMode: async (mode: PermissionMode) =>
      closed
        ? Result.err(sessionClosed())
        : setQueryPermissionMode(claude, mode),
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

const claudeConfigDir = (env: NodeJS.ProcessEnv) =>
  env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

const SETTING_SOURCES: SettingSource[] = ["user", "project", "local"];

// resolveSettings resolves settings directories such as CLAUDE_CONFIG_DIR from this process's environment, so Claude starts from the same one and differs only by the billing variables removed from it.
const PROCESS_RUNTIME: ClaudeRuntime = {
  query,
  resolveSettings,
  env: process.env,
};

const sessionClosed = () =>
  new ClaudeSessionClosed({ message: "the Claude session is closed" });
