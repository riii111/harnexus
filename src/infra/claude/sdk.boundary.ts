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

export const readAccount = (query: ClaudeQuery) =>
  Result.tryPromise({
    try: () => query.accountInfo(),
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

export const readSupportedModels = (query: ClaudeQuery) =>
  Result.tryPromise({
    try: () => query.supportedModels(),
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
