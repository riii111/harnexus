import {
  type CanUseTool,
  type EffortLevel,
  getSessionMessages,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  query,
  resolveSettings,
  type SDKMessage,
  type SessionMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { Result, TaggedError } from "better-result";
import { readTextFileIfExists } from "../../runtime/fs.boundary.ts";
import {
  checkSettingsEnv,
  checkSubscription,
  type Env,
  withoutApiBilling,
} from "./auth.ts";
import { modelsFromSdk } from "./models.ts";
import { createPromptQueue } from "./prompt-queue.ts";
import {
  type ClaudeQuery,
  ClaudeRecordUnreadable,
  type ClaudeSdk,
  type ClaudeStreamFailed,
  closeQuery,
  interruptQuery,
  nextMessage,
  openQuery,
  readAccount,
  readSessionMessages,
  readSettings,
  readSupportedModels,
  setQueryEffort,
  setQueryPermissionMode,
} from "./sdk.boundary.ts";
import { claudeConfigDir, findSessionFile } from "./transcripts.ts";

export type ClaudeSessionSettings = {
  cwd: string;
  model: string;
  resume?: string;
  // Resumes into a new conversation, leaving the resumed one as it was.
  forkSession?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  // Tools that run without asking, on top of the user's own allow rules.
  allowedTools?: string[];
  canUseTool: CanUseTool;
};

class ClaudeSessionClosed extends TaggedError("ClaudeSessionClosed")<{
  message: string;
}> {}

class NoClaudeModelsListed extends TaggedError("NoClaudeModelsListed")<{
  message: string;
}> {}

type ClaudeRuntime = ClaudeSdk & { env: Env };

// The settings and the account are checked before any prompt is sent, so a login that would bill the API never starts a conversation.
export const startClaudeSession = (
  settings: ClaudeSessionSettings,
  runtime: ClaudeRuntime = PROCESS_RUNTIME,
) =>
  Result.gen(async function* () {
    const resolved = yield* Result.await(
      readSettings(runtime.resolveSettings, settings.cwd, SETTING_SOURCES),
    );
    yield* checkSettingsEnv(resolved.env ?? {});
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

// Project settings differ by thread, while the model list shows one default, so only the user's settings are read; a turn's level overrides a project's level but not a cap set by a project or an organization.
export const loadEffortSettings = (
  cwd: string = process.cwd(),
  runtime: Pick<ClaudeRuntime, "resolveSettings"> = PROCESS_RUNTIME,
) => readSettings(runtime.resolveSettings, cwd, USER_SETTINGS);

// The models Claude Code runs depend on the Claude Code version the SDK bundles.
export const loadClaudeModels = async (
  runtime: ClaudeRuntime = PROCESS_RUNTIME,
  cwd: string = process.cwd(),
  timeoutMs: number = MODELS_TIMEOUT_MS,
) =>
  (
    await askClaude(runtime, cwd, (claude) =>
      readSupportedModels(claude, timeoutMs),
    )
  ).andThen((infos) => {
    const models = modelsFromSdk(infos);
    return models.length === 0
      ? Result.err(
          new NoClaudeModelsListed({
            message: "Claude Code listed no Claude model",
          }),
        )
      : Result.ok(models);
  });

// Reports the subscription a session would run on, refusing a login that would bill the API as a session does.
export const readClaudeLogin = async (
  runtime: ClaudeRuntime = PROCESS_RUNTIME,
  cwd: string = process.cwd(),
  timeoutMs: number = MODELS_TIMEOUT_MS,
) =>
  (
    await askClaude(runtime, cwd, (claude) => readAccount(claude, timeoutMs))
  ).andThen((account) =>
    Result.gen(function* () {
      yield* checkSubscription(account);
      return Result.ok(account.subscriptionType ?? "subscription");
    }),
  );

// Asking Claude Code about itself sends no prompt, so the process is closed as soon as it answers.
// Only the user's settings are read, since the bridge's directory is no thread's project, and they pass the same check as a session so the answer is the subscription's.
const askClaude = <T, E>(
  runtime: ClaudeRuntime,
  cwd: string,
  ask: (claude: ClaudeQuery) => Promise<Result<T, E>>,
) =>
  Result.gen(async function* () {
    const resolved = yield* Result.await(
      readSettings(runtime.resolveSettings, cwd, USER_SETTINGS),
    );
    yield* checkSettingsEnv(resolved.env ?? {});
    const prompt = createPromptQueue();
    const claude = yield* openQuery(runtime.query, prompt.stream, {
      cwd,
      env: withoutApiBilling(runtime.env),
      settingSources: USER_SETTINGS,
    });
    const answer = await ask(claude);
    prompt.end();
    closeQuery(claude);
    const value = yield* answer;
    return Result.ok(value);
  });

// Claude keeps a conversation as <session id>.jsonl in a project folder under its config directory, which the user may delete or move to another machine.
// The SDK's lookup reports an unreadable record as missing, so absence is concluded only when every project folder could be listed without finding the file.
export const claudeSessionExists = async (
  sessionId: string,
  configDir: string = claudeConfigDir(process.env),
) => (await findSessionFile(sessionId, configDir)).map((path) => path !== null);

// Without a project folder the SDK searches every project, as the thread's directory may not be where the record was written.
// getSessionMessages answers a record it cannot read with no messages, so an empty answer is checked against the record file itself.
export const readClaudeSession = (
  sessionId: string,
  {
    read = getSessionMessages,
    configDir = claudeConfigDir(process.env),
  }: {
    read?: (sessionId: string) => Promise<SessionMessage[]>;
    configDir?: string;
  } = {},
) =>
  Result.gen(async function* () {
    const messages = yield* Result.await(readSessionMessages(read, sessionId));
    if (messages.length === 0) {
      yield* Result.await(checkRecordReadable(sessionId, configDir));
    }
    return Result.ok(messages);
  });

// A record that is absent is an empty conversation, but one that exists or may exist without being readable is a failure.
const checkRecordReadable = async (sessionId: string, configDir: string) =>
  (
    await Result.gen(async function* () {
      const path = yield* Result.await(findSessionFile(sessionId, configDir));
      if (path !== null) yield* Result.await(readTextFileIfExists(path));
      return Result.ok();
    })
  ).mapError(
    (cause) =>
      new ClaudeRecordUnreadable({
        cause,
        message: "cannot read the Claude conversation record",
      }),
  );

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
  ...(settings.forkSession === true && { forkSession: true }),
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
    send: (text: string, attachments: readonly string[] = []) => {
      const uuid = closed ? null : prompt.push(text, attachments);
      return uuid === null ? Result.err(sessionClosed()) : Result.ok(uuid);
    },
    interrupt: async () =>
      closed ? Result.err(sessionClosed()) : interruptQuery(claude),
    setPermissionMode: async (mode: PermissionMode) =>
      closed
        ? Result.err(sessionClosed())
        : setQueryPermissionMode(claude, mode),
    setEffort: async (effort: EffortLevel) =>
      closed ? Result.err(sessionClosed()) : setQueryEffort(claude, effort),
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

const SETTING_SOURCES: SettingSource[] = ["user", "project", "local"];

const USER_SETTINGS: SettingSource[] = ["user"];

// Starting Claude Code and listing its models takes about 3.5 s on the verification Mac.
const MODELS_TIMEOUT_MS = 30_000;

// resolveSettings resolves settings directories such as CLAUDE_CONFIG_DIR from this process's environment, so Claude starts from the same one and differs only by the billing variables removed from it.
const PROCESS_RUNTIME: ClaudeRuntime = {
  query,
  resolveSettings,
  env: process.env,
};

const sessionClosed = () =>
  new ClaudeSessionClosed({ message: "the Claude session is closed" });
