import type {
  createSdkMcpServer,
  EffortLevel,
  McpSdkServerConfigWithInstance,
  Options,
  PermissionMode,
  Query,
  SDKUserMessage,
  SessionMessage,
  SettingSource,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { Result, TaggedError } from "better-result";

export type ClaudeQuery = Pick<
  Query,
  | "next"
  | "interrupt"
  | "setPermissionMode"
  | "applyFlagSettings"
  | "supportedModels"
  | "accountInfo"
  | "close"
>;

type RunQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;

type ResolveSettings = (options: {
  cwd: string;
  settingSources: SettingSource[];
}) => Promise<{
  effective: Pick<
    Settings,
    "env" | "effortLevel" | "maxEffortLevel" | "modelSettings"
  >;
}>;

type GetSessionMessages = (sessionId: string) => Promise<SessionMessage[]>;

export type GetSubagentMessages = (
  sessionId: string,
  agentId: string,
) => Promise<SessionMessage[]>;

type CreateSdkMcpServer = typeof createSdkMcpServer;

// Tools the SDK serves in this process, by the name of the server they are served under.
export type ToolServers = Record<
  string,
  NonNullable<Parameters<CreateSdkMcpServer>[0]["tools"]>
>;

export type ClaudeSdk = {
  query: RunQuery;
  resolveSettings: ResolveSettings;
  createSdkMcpServer: CreateSdkMcpServer;
};

class ClaudeSdkUnavailable extends TaggedError("ClaudeSdkUnavailable")<{
  cause: unknown;
  message: string;
}> {}

class ClaudeSettingsUnavailable extends TaggedError(
  "ClaudeSettingsUnavailable",
)<{
  cause: unknown;
  message: string;
}> {}

class ClaudeStartFailed extends TaggedError("ClaudeStartFailed")<{
  cause: unknown;
  message: string;
}> {}

class ClaudeAccountUnavailable extends TaggedError("ClaudeAccountUnavailable")<{
  cause: unknown;
  message: string;
}> {}

class ClaudeStreamFailed extends TaggedError("ClaudeStreamFailed")<{
  cause: unknown;
  message: string;
}> {}

class ClaudeInterruptFailed extends TaggedError("ClaudeInterruptFailed")<{
  cause: unknown;
  message: string;
}> {}

class ClaudePermissionModeFailed extends TaggedError(
  "ClaudePermissionModeFailed",
)<{
  cause: unknown;
  message: string;
}> {}

class ClaudeEffortFailed extends TaggedError("ClaudeEffortFailed")<{
  cause: unknown;
  message: string;
}> {}

class ClaudeModelsUnavailable extends TaggedError("ClaudeModelsUnavailable")<{
  cause: unknown;
  message: string;
}> {}

export class ClaudeRecordUnreadable extends TaggedError(
  "ClaudeRecordUnreadable",
)<{
  cause: unknown;
  message: string;
}> {}

export type { ClaudeStreamFailed };

export const loadClaudeSdk = () =>
  Result.tryPromise({
    // The SDK takes about 50 ms to load, so it is imported when Claude is first needed rather than when the bridge starts, which would hold back the app's connection.
    try: () => import("@anthropic-ai/claude-agent-sdk"),
    catch: (cause) =>
      new ClaudeSdkUnavailable({
        cause,
        message: "cannot load the Claude Agent SDK",
      }),
  });

export const openToolServers = (
  create: CreateSdkMcpServer,
  servers: ToolServers,
) =>
  Result.try({
    try: () =>
      Object.fromEntries(
        Object.entries(servers).map(
          ([name, tools]): [string, McpSdkServerConfigWithInstance] => [
            name,
            create({ name, tools }),
          ],
        ),
      ),
    catch: (cause) =>
      new ClaudeStartFailed({ cause, message: "cannot start Claude" }),
  });

export const readSettings = (
  resolve: ResolveSettings,
  cwd: string,
  settingSources: SettingSource[],
) =>
  Result.tryPromise({
    // resolveSettings merges the same files as the CLI without starting it, but skips an admin policyHelper.
    try: async () => (await resolve({ cwd, settingSources })).effective,
    catch: (cause) =>
      new ClaudeSettingsUnavailable({
        cause,
        message: "cannot read the Claude settings",
      }),
  });

export const openQuery = (
  run: RunQuery,
  prompt: AsyncIterable<SDKUserMessage>,
  options: Options,
) =>
  Result.try({
    try: () => run({ prompt, options }),
    catch: (cause) =>
      new ClaudeStartFailed({ cause, message: "cannot start Claude" }),
  });

export const readAccount = (
  query: ClaudeQuery,
  // Without a limit a session waits for the account as long as Claude Code starts; a caller outside a session gives a limit so a stuck start cannot hold it.
  timeoutMs?: number,
  signal?: AbortSignal,
) =>
  Result.tryPromise({
    try: () => {
      if (signal?.aborted)
        return Promise.reject(new Error("operation aborted"));
      const account = query.accountInfo();
      const pending =
        timeoutMs === undefined ? account : withinTime(account, timeoutMs);
      return signal === undefined
        ? pending
        : withinAbortSignal(pending, signal);
    },
    catch: (cause) =>
      new ClaudeAccountUnavailable({
        cause,
        message: "cannot read the Claude account",
      }),
  });

export const nextMessage = (query: ClaudeQuery) =>
  Result.tryPromise({
    try: () => query.next(),
    catch: (cause) =>
      new ClaudeStreamFailed({
        cause,
        message: "the Claude message stream failed",
      }),
  });

export const interruptQuery = (query: ClaudeQuery) =>
  Result.tryPromise({
    // A missing receipt means an older CLI that cannot say which sends survive the interrupt.
    try: async () => (await query.interrupt())?.still_queued ?? null,
    catch: (cause) =>
      new ClaudeInterruptFailed({
        cause,
        message: "cannot interrupt the Claude turn",
      }),
  });

export const setQueryPermissionMode = (
  query: ClaudeQuery,
  mode: PermissionMode,
) =>
  Result.tryPromise({
    try: () => query.setPermissionMode(mode),
    catch: (cause) =>
      new ClaudePermissionModeFailed({
        cause,
        message: `cannot switch Claude to the ${mode} permission mode`,
      }),
  });

export const readSupportedModels = (query: ClaudeQuery, timeoutMs: number) =>
  Result.tryPromise({
    // A Claude Code that never answers would otherwise keep its process running for the whole bridge.
    try: () => withinTime(query.supportedModels(), timeoutMs),
    catch: (cause) =>
      new ClaudeModelsUnavailable({
        cause,
        message: "cannot read the models Claude Code offers",
      }),
  });

export const setQueryEffort = (query: ClaudeQuery, effort: EffortLevel) =>
  Result.tryPromise({
    // The flag layer holds the level for this session only, so the user's settings files keep their own effortLevel.
    try: () => query.applyFlagSettings({ effortLevel: effort }),
    catch: (cause) =>
      new ClaudeEffortFailed({
        cause,
        message: `cannot switch Claude to the ${effort} effort`,
      }),
  });

export const readSessionMessages = (
  read: GetSessionMessages,
  sessionId: string,
) =>
  Result.tryPromise({
    try: () => read(sessionId),
    // The SDK also answers a missing or unreadable record with no messages, so an error here covers only a read that fails outright.
    catch: (cause) =>
      new ClaudeRecordUnreadable({
        cause,
        message: "cannot read the Claude conversation record",
      }),
  });

export const readSubagentMessages = (
  read: GetSubagentMessages,
  sessionId: string,
  agentId: string,
) =>
  Result.tryPromise({
    try: () => read(sessionId, agentId),
    catch: (cause) =>
      new ClaudeRecordUnreadable({
        cause,
        message: "cannot read a Claude subagent's record",
      }),
  });

export const closeQuery = (query: ClaudeQuery) => {
  try {
    query.close();
  } catch {
    // Closing kills the Claude process, and a failure there leaves nothing the caller can do.
  }
};

const withinTime = async <T>(pending: Promise<T>, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`Claude Code did not answer in ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const withinAbortSignal = <T>(pending: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    const finish = (action: () => void) => {
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(new Error("operation aborted")));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (cause: unknown) => finish(() => reject(cause)),
    );
  });
