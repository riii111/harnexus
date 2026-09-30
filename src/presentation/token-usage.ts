import type { ModelUsage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AppNotification, TokenUsageBreakdown } from "./protocol.ts";

// total adds up the thread's turns while the bridge runs, last is the context the latest request of the main conversation carried, and contextWindow is the window a result reported for windowModel.
export type ThreadUsage = {
  readonly total: TokenUsageBreakdown;
  readonly last: TokenUsageBreakdown;
  readonly contextWindow: number | null;
  readonly windowModel: string | null;
};

const NO_TOKENS: TokenUsageBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

export const NO_USAGE: ThreadUsage = {
  total: NO_TOKENS,
  last: NO_TOKENS,
  contextWindow: null,
  windowModel: null,
};

// A request's final usage arrives in its message_delta, since the assistant message carries the output counted so far; a result sums the requests of its turn.
export const renderTokenUsage = (
  usage: ThreadUsage,
  message: SDKMessage,
  turn: { threadId: string; turnId: string; model: string; now: number },
): { usage: ThreadUsage; notification: AppNotification | null } => {
  const next = nextUsage(usage, message, turn.model);
  if (next === null) return { usage, notification: null };
  return {
    usage: next,
    notification: {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: turn.threadId,
        turnId: turn.turnId,
        tokenUsage: {
          total: next.total,
          last: next.last,
          // A model change shows no window until the new model's first result.
          modelContextWindow:
            next.windowModel === turn.model ? next.contextWindow : null,
        },
      },
      emittedAtMs: turn.now,
    },
  };
};

const nextUsage = (
  usage: ThreadUsage,
  message: SDKMessage,
  model: string,
): ThreadUsage | null => {
  if (
    message.type === "stream_event" &&
    message.parent_tool_use_id === null &&
    message.event.type === "message_delta"
  ) {
    return { ...usage, last: breakdown(message.event.usage) };
  }
  if (message.type === "result") {
    return {
      ...usage,
      total: add(usage.total, breakdown(message.usage)),
      ...(contextWindowOf(message.modelUsage, model) ?? {
        contextWindow: usage.contextWindow,
        windowModel: usage.windowModel,
      }),
    };
  }
  return null;
};

// Claude counts cached input apart from input_tokens, while the app's input includes it, and thinking is part of the output in both.
export const breakdown = (usage: ApiUsage): TokenUsageBreakdown => {
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteInputTokens = usage.cache_creation_input_tokens ?? 0;
  const inputTokens =
    (usage.input_tokens ?? 0) + cachedInputTokens + cacheWriteInputTokens;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
};

// modelUsage also lists models a subagent ran on, so the thread's own model is looked up first under the id without its context suffix.
const contextWindowOf = (
  modelUsage: Record<string, ModelUsage>,
  model: string,
) => {
  const own =
    modelUsage[model] ?? modelUsage[model.replace(CONTEXT_SUFFIX, "")];
  if (own !== undefined) {
    return { contextWindow: own.contextWindow, windowModel: model };
  }
  const windows = Object.values(modelUsage).map(
    ({ contextWindow }) => contextWindow,
  );
  return windows.length === 0
    ? null
    : { contextWindow: Math.max(...windows), windowModel: model };
};

const add = (
  a: TokenUsageBreakdown,
  b: TokenUsageBreakdown,
): TokenUsageBreakdown => ({
  totalTokens: a.totalTokens + b.totalTokens,
  inputTokens: a.inputTokens + b.inputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
});

// The fields a message_delta and a result share; a delta may leave the input counts null.
type ApiUsage = {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number | null } | null;
};

const CONTEXT_SUFFIX = /\[[^\]]*\]$/;
