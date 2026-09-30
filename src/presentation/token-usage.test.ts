import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { NO_USAGE, renderTokenUsage } from "./token-usage.ts";

describe("renderTokenUsage", () => {
  test("reports a request's final usage as the context, counting cached input as input", () => {
    const rendered = renderTokenUsage(NO_USAGE, delta(DELTA_USAGE), TURN);

    expect(rendered.notification).toEqual({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "th-fixture-1",
        turnId: "turn-1",
        tokenUsage: {
          total: ZERO,
          last: {
            totalTokens: 3106,
            inputTokens: 3025,
            cachedInputTokens: 2000,
            cacheWriteInputTokens: 1000,
            outputTokens: 81,
            reasoningOutputTokens: 30,
          },
          modelContextWindow: null,
        },
      },
      emittedAtMs: 1_700_000_000_000,
    });
  });

  test("adds each result to the thread's total and keeps the latest context", () => {
    const first = renderTokenUsage(NO_USAGE, delta(DELTA_USAGE), TURN);
    const afterFirst = renderTokenUsage(
      first.usage,
      result(RESULT_USAGE),
      TURN,
    );

    const afterSecond = renderTokenUsage(
      afterFirst.usage,
      result(RESULT_USAGE),
      TURN,
    );

    expect(afterSecond.notification?.params).toMatchObject({
      tokenUsage: {
        total: { inputTokens: 220, outputTokens: 20, totalTokens: 240 },
        last: { totalTokens: 3106 },
      },
    });
  });

  test.each([
    {
      name: "the thread's model",
      modelUsage: {
        "claude-haiku-4-5": window(200_000),
        [MODEL]: window(1_000_000),
      },
      model: MODEL,
      expected: 1_000_000,
    },
    {
      name: "the thread's model without its context suffix",
      modelUsage: { "claude-fable-5-1": window(1_000_000) },
      model: "claude-fable-5-1[1m]",
      expected: 1_000_000,
    },
    {
      name: "the largest window when the thread's model is not listed",
      modelUsage: {
        "claude-haiku-4-5": window(200_000),
        "claude-opus-5-5": window(1_000_000),
      },
      model: MODEL,
      expected: 1_000_000,
    },
  ])("takes the context window of $name", ({ modelUsage, model, expected }) => {
    const rendered = renderTokenUsage(
      NO_USAGE,
      result(RESULT_USAGE, modelUsage),
      { ...TURN, model },
    );

    expect(rendered.usage.contextWindow).toBe(expected);
  });

  test("keeps the window from an earlier result when a result lists no model", () => {
    const earlier = renderTokenUsage(
      NO_USAGE,
      result(RESULT_USAGE, { [MODEL]: window(1_000_000) }),
      TURN,
    );

    const later = renderTokenUsage(
      earlier.usage,
      result(RESULT_USAGE, {}),
      TURN,
    );

    expect(later.usage.contextWindow).toBe(1_000_000);
  });

  test.each([
    {
      name: "a subagent's request",
      message: { ...delta(DELTA_USAGE), parent_tool_use_id: "tool-1" },
    },
    {
      name: "an assistant message, whose output is not final",
      message: {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "msg-1", content: [], usage: DELTA_USAGE },
      },
    },
    {
      name: "another stream event",
      message: {
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "message_stop" },
      },
    },
  ])("reports nothing for $name", ({ message }) => {
    const rendered = renderTokenUsage(
      NO_USAGE,
      message as unknown as SDKMessage,
      TURN,
    );

    expect(rendered).toEqual({ usage: NO_USAGE, notification: null });
  });
});

const MODEL = "claude-sonnet-5-5";

const TURN = {
  threadId: "th-fixture-1",
  turnId: "turn-1",
  model: MODEL,
  now: 1_700_000_000_000,
};

const ZERO = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

const DELTA_USAGE = {
  input_tokens: 25,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 1000,
  output_tokens: 81,
  output_tokens_details: { thinking_tokens: 30 },
};

const RESULT_USAGE = {
  input_tokens: 10,
  cache_read_input_tokens: 60,
  cache_creation_input_tokens: 40,
  output_tokens: 10,
};

const window = (contextWindow: number) => ({ contextWindow });

const delta = (usage: object) =>
  ({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "message_delta", delta: {}, usage },
  }) as unknown as SDKMessage;

const result = (usage: object, modelUsage: object = {}) =>
  ({
    type: "result",
    subtype: "success",
    usage,
    modelUsage,
  }) as unknown as SDKMessage;
