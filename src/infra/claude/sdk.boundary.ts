import type {
  EffortLevel,
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

export type ClaudeSdk = {
  query: RunQuery;
  resolveSettings: ResolveSettings;
};

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

// resolveSettings merges the same files as the CLI without starting it, but skips an admin policyHelper.
export const readSettings = (
  resolve: ResolveSettings,
  cwd: string,
  settingSources: SettingSource[],
) =>
  Result.tryPromise({
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

// Without a limit a session waits for the account as long as Claude Code starts; a caller outside a session gives a limit so a stuck start cannot hold it.
export const readAccount = (
  query: ClaudeQuery,
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

// A Claude Code that never answers would otherwise keep its process running for the whole bridge.
export const readSupportedModels = (query: ClaudeQuery, timeoutMs: number) =>
  Result.tryPromise({
    try: () => withinTime(query.supportedModels(), timeoutMs),
    catch: (cause) =>
      new ClaudeModelsUnavailable({
        cause,
        message: "cannot read the models Claude Code offers",
      }),
  });

// The flag layer holds the level for this session only, so the user's settings files keep their own effortLevel.
export const setQueryEffort = (query: ClaudeQuery, effort: EffortLevel) =>
  Result.tryPromise({
    try: () => query.applyFlagSettings({ effortLevel: effort }),
    catch: (cause) =>
      new ClaudeEffortFailed({
        cause,
        message: `cannot switch Claude to the ${effort} effort`,
      }),
  });

// The SDK also answers a missing or unreadable record with no messages, so an error here covers only a read that fails outright.
export const readSessionMessages = (
  read: GetSessionMessages,
  sessionId: string,
) =>
  Result.tryPromise({
    try: () => read(sessionId),
    catch: (cause) =>
      new ClaudeRecordUnreadable({
        cause,
        message: "cannot read the Claude conversation record",
      }),
  });

// Closing kills the Claude process, and a failure there leaves nothing the caller can do.
export const closeQuery = (query: ClaudeQuery) => {
  try {
    query.close();
  } catch {}
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
