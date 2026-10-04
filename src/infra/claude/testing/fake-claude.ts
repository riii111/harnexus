import type {
  AccountInfo,
  EffortLevel,
  ModelInfo,
  Options,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery, ClaudeSdk } from "../sdk.boundary.ts";

type Delivery = IteratorResult<SDKMessage, void> | Error;

// Mirrors the SDK: reads wait for the next message, failures surface as thrown errors, and close ends a pending read.
export const fakeClaude = (
  account: AccountInfo | Error,
  {
    interruptError,
    permissionModeError,
    effortError,
    interruptAnswered,
    accountAnswered,
    stillQueued,
    closeEnding = { done: true, value: undefined },
    settingsEnv = {},
    userSettingsEnv,
    effortSettings = {},
    models = [],
    env = { PATH: "/usr/bin" },
  }: {
    interruptError?: Error;
    permissionModeError?: Error;
    effortError?: Error;
    // Holds the interrupt receipt back, as the CLI may send it after the turn's result.
    interruptAnswered?: Promise<void>;
    // Holds the account back, as a Claude Code stuck starting would.
    accountAnswered?: Promise<void>;
    stillQueued?: string[];
    closeEnding?: Delivery;
    settingsEnv?: Record<string, string> | Error;
    // What the user's settings alone hold; without it they hold the same env as every source.
    userSettingsEnv?: Record<string, string>;
    effortSettings?: Pick<Settings, "effortLevel" | "modelSettings">;
    // "unanswered" stands for a Claude Code that never lists its models.
    models?: ModelInfo[] | Error | "unanswered";
    env?: Record<string, string | undefined>;
  } = {},
) => {
  const queued: Delivery[] = [];
  let waiting: ((item: Delivery) => void) | null = null;
  let options: Options | null = null;
  let prompt: AsyncIterable<SDKUserMessage> | null = null;
  const received: SDKUserMessage[] = [];
  let nextCalls = 0;
  let interrupts = 0;
  const modes: PermissionMode[] = [];
  const efforts: (EffortLevel | null | undefined)[] = [];
  let closes = 0;
  const deliver = (item: Delivery) => {
    const resolve = waiting;
    waiting = null;
    if (resolve === null) queued.push(item);
    else resolve(item);
  };
  const claude: ClaudeQuery = {
    next: async () => {
      nextCalls += 1;
      const item =
        queued.shift() ??
        (await new Promise<Delivery>((resolve) => {
          waiting = resolve;
        }));
      // biome-ignore lint/plugin/no-throw-try-catch: fakes the Claude SDK, which reports failures by throwing.
      if (item instanceof Error) throw item;
      return item;
    },
    interrupt: async () => {
      interrupts += 1;
      await interruptAnswered;
      // biome-ignore lint/plugin/no-throw-try-catch: fakes the Claude SDK, which reports failures by throwing.
      if (interruptError !== undefined) throw interruptError;
      return stillQueued === undefined
        ? undefined
        : { still_queued: stillQueued };
    },
    setPermissionMode: async (mode) => {
      // biome-ignore lint/plugin/no-throw-try-catch: fakes the Claude SDK, which reports failures by throwing.
      if (permissionModeError !== undefined) throw permissionModeError;
      modes.push(mode);
    },
    applyFlagSettings: async (settings) => {
      // biome-ignore lint/plugin/no-throw-try-catch: fakes the Claude SDK, which reports failures by throwing.
      if (effortError !== undefined) throw effortError;
      efforts.push(settings.effortLevel);
    },
    supportedModels: async () => {
      // biome-ignore lint/plugin/no-throw-try-catch: fakes the Claude SDK, which reports failures by throwing.
      if (models instanceof Error) throw models;
      if (models === "unanswered") return new Promise<ModelInfo[]>(() => {});
      return models;
    },
    accountInfo: async () => {
      await accountAnswered;
      // biome-ignore lint/plugin/no-throw-try-catch: fakes the Claude SDK, which reports failures by throwing.
      if (account instanceof Error) throw account;
      return account;
    },
    close: () => {
      closes += 1;
      deliver(closeEnding);
    },
  };
  const resolveSettings: ClaudeSdk["resolveSettings"] = async ({
    settingSources,
  }) => {
    // biome-ignore lint/plugin/no-throw-try-catch: fakes the Claude SDK, which reports failures by throwing.
    if (settingsEnv instanceof Error) throw settingsEnv;
    if (userSettingsEnv !== undefined && settingSources.join() === "user") {
      return { effective: { env: userSettingsEnv, ...effortSettings } };
    }
    return { effective: { env: settingsEnv, ...effortSettings } };
  };
  const run: ClaudeSdk["query"] = (params) => {
    options = params.options;
    prompt = readAhead(params.prompt, received);
    return claude;
  };
  return {
    runtime: {
      query: run,
      resolveSettings,
      env,
    } satisfies ClaudeSdk & { env: Record<string, string | undefined> },
    // True once the consumer has handled every message emitted so far and waits for the next one.
    drained: () => waiting !== null && queued.length === 0,
    started: () => options !== null,
    // True once the runtime has sent Claude a prompt, which it does only after the session is started and confirmed.
    prompted: () => received.length > 0,
    options: () => options ?? {},
    prompt: () => prompt,
    prompts: async () => {
      const sent: SDKUserMessage[] = [];
      if (prompt !== null)
        for await (const message of prompt) sent.push(message);
      return sent;
    },
    emit: (message: SDKMessage) => deliver({ done: false, value: message }),
    end: () => deliver({ done: true, value: undefined }),
    fail: (error: Error) => deliver(error),
    interrupts: () => interrupts,
    modes: () => modes,
    efforts: () => efforts,
    closes: () => closes,
    nextCalls: () => nextCalls,
  };
};

export const failingQuery =
  (error: Error): ClaudeSdk["query"] =>
  () => {
    // biome-ignore lint/plugin/no-throw-try-catch: fakes the Claude SDK, which reports failures by throwing.
    throw error;
  };

// Reads the prompt as the SDK does, as soon as each message is sent, and replays it to the test from a shared position as the original stream would.
const readAhead = (
  source: AsyncIterable<SDKUserMessage>,
  received: SDKUserMessage[],
): AsyncIterable<SDKUserMessage> => {
  let ended = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  void (async () => {
    for await (const message of source) {
      received.push(message);
      notify();
    }
    ended = true;
    notify();
  })();
  let next = 0;
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const message = received[next];
        if (message !== undefined) {
          next += 1;
          yield message;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
};
