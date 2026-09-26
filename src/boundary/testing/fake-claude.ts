import type {
  AccountInfo,
  Options,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery, ClaudeSdk } from "../claude-sdk.ts";

type Delivery = IteratorResult<SDKMessage, void> | Error;

// Mirrors the SDK: reads wait for the next message, failures surface as thrown errors, and close ends a pending read.
export const fakeClaude = (
  account: AccountInfo | Error,
  {
    interruptError,
    interruptAnswered,
    stillQueued,
    closeEnding = { done: true, value: undefined },
    settingsEnv = {},
    env = { PATH: "/usr/bin" },
  }: {
    interruptError?: Error;
    // Holds the interrupt receipt back, as the CLI may send it after the turn's result.
    interruptAnswered?: Promise<void>;
    stillQueued?: string[];
    closeEnding?: Delivery;
    settingsEnv?: Record<string, string> | Error;
    env?: Record<string, string | undefined>;
  } = {},
) => {
  const queued: Delivery[] = [];
  let waiting: ((item: Delivery) => void) | null = null;
  let options: Options | null = null;
  let prompt: AsyncIterable<SDKUserMessage> | null = null;
  let interrupts = 0;
  const modes: PermissionMode[] = [];
  let closes = 0;
  const deliver = (item: Delivery) => {
    const resolve = waiting;
    waiting = null;
    if (resolve === null) queued.push(item);
    else resolve(item);
  };
  const claude: ClaudeQuery = {
    next: async () => {
      const item =
        queued.shift() ??
        (await new Promise<Delivery>((resolve) => {
          waiting = resolve;
        }));
      if (item instanceof Error) throw item;
      return item;
    },
    interrupt: async () => {
      interrupts += 1;
      await interruptAnswered;
      if (interruptError !== undefined) throw interruptError;
      return stillQueued === undefined
        ? undefined
        : { still_queued: stillQueued };
    },
    setPermissionMode: async (mode) => {
      modes.push(mode);
    },
    accountInfo: async () => {
      if (account instanceof Error) throw account;
      return account;
    },
    close: () => {
      closes += 1;
      deliver(closeEnding);
    },
  };
  const resolveSettings: ClaudeSdk["resolveSettings"] = async () => {
    if (settingsEnv instanceof Error) throw settingsEnv;
    return { effective: { env: settingsEnv } };
  };
  const run: ClaudeSdk["query"] = (params) => {
    options = params.options;
    prompt = params.prompt;
    return claude;
  };
  return {
    runtime: {
      query: run,
      resolveSettings,
      env,
    } satisfies ClaudeSdk & { env: Record<string, string | undefined> },
    started: () => options !== null,
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
    closes: () => closes,
  };
};

export const failingQuery =
  (error: Error): ClaudeSdk["query"] =>
  () => {
    throw error;
  };
