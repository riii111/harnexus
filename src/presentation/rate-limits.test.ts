import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type ClaudeLimits,
  NO_LIMITS,
  recordRateLimits,
  renderClaudeLimits,
} from "./rate-limits.ts";

describe("recordRateLimits", () => {
  test("reads both windows from the unified windows the CLI sends", () => {
    const recorded = recordRateLimits(
      NO_LIMITS,
      rateLimitEvent({
        status: "allowed",
        resetsAt: FIVE_HOUR_RESET,
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 0.26, resetsAt: FIVE_HOUR_RESET },
          seven_day: { utilization: 0.56, resetsAt: SEVEN_DAY_RESET },
        },
      }),
    );

    expect(recorded).toEqual({
      fiveHour: { utilization: 0.26, resetsAt: FIVE_HOUR_RESET },
      sevenDay: { utilization: 0.56, resetsAt: SEVEN_DAY_RESET },
    });
  });

  test.each([
    {
      rateLimitType: "five_hour",
      expected: {
        fiveHour: { utilization: 0.9, resetsAt: FIVE_HOUR_RESET },
        sevenDay: null,
      },
    },
    {
      rateLimitType: "seven_day",
      expected: {
        fiveHour: null,
        sevenDay: { utilization: 0.9, resetsAt: FIVE_HOUR_RESET },
      },
    },
  ])("records the documented usage of a $rateLimitType event in that window", ({
    rateLimitType,
    expected,
  }) => {
    const recorded = recordRateLimits(
      NO_LIMITS,
      rateLimitEvent({
        status: "allowed_warning",
        rateLimitType,
        utilization: 0.9,
        resetsAt: FIVE_HOUR_RESET,
      }),
    );

    expect(recorded).toEqual(expected);
  });

  test("keeps a window a later event does not report and replaces the one it does", () => {
    const earlier = recordRateLimits(NO_LIMITS, unified(0.26, 0.56));

    const later = recordRateLimits(
      earlier,
      rateLimitEvent({
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.8,
        resetsAt: FIVE_HOUR_RESET,
      }),
    );

    expect(later).toEqual({
      fiveHour: { utilization: 0.8, resetsAt: FIVE_HOUR_RESET },
      sevenDay: { utilization: 0.56, resetsAt: SEVEN_DAY_RESET },
    });
  });

  test.each([
    {
      name: "a model-specific weekly limit",
      message: rateLimitEvent({
        status: "allowed_warning",
        rateLimitType: "seven_day_opus",
        utilization: 0.9,
        resetsAt: SEVEN_DAY_RESET,
      }),
    },
    {
      name: "an event without usage",
      message: rateLimitEvent({
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAt: FIVE_HOUR_RESET,
      }),
    },
    {
      name: "a message other than a rate limit event",
      message: { type: "result", subtype: "success" } as unknown as SDKMessage,
    },
  ])("leaves the limits as they were for $name", ({ message }) => {
    const earlier = recordRateLimits(NO_LIMITS, unified(0.26, 0.56));

    expect(recordRateLimits(earlier, message)).toEqual(earlier);
  });
});

describe("renderClaudeLimits", () => {
  test("gives percentages from 0 to 100 and the windows' lengths under the Claude id", () => {
    const limits = recordRateLimits(NO_LIMITS, unified(0.26, 0.56));

    expect(renderClaudeLimits(limits, NOW_MS)).toEqual({
      limitId: "claude",
      limitName: "Claude",
      normalModelSlug: null,
      primary: {
        usedPercent: 26,
        windowDurationMins: 300,
        resetsAt: FIVE_HOUR_RESET,
      },
      secondary: {
        usedPercent: 56,
        windowDurationMins: 10_080,
        resetsAt: SEVEN_DAY_RESET,
      },
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    });
  });

  test("drops a window whose reset has passed", () => {
    const limits = recordRateLimits(NO_LIMITS, unified(0.26, 0.56));

    const rendered = renderClaudeLimits(limits, FIVE_HOUR_RESET * 1000);

    expect(rendered).toMatchObject({
      primary: null,
      secondary: { usedPercent: 56 },
    });
  });

  test.each<{ name: string; limits: ClaudeLimits; nowMs: number }>([
    { name: "no event has reported limits", limits: NO_LIMITS, nowMs: NOW_MS },
    {
      name: "every window has reset",
      limits: {
        fiveHour: { utilization: 0.26, resetsAt: FIVE_HOUR_RESET },
        sevenDay: { utilization: 0.56, resetsAt: SEVEN_DAY_RESET },
      },
      nowMs: SEVEN_DAY_RESET * 1000,
    },
  ])("gives no entry when $name", ({ limits, nowMs }) => {
    expect(renderClaudeLimits(limits, nowMs)).toBeNull();
  });
});

const rateLimitEvent = (info: object) =>
  ({
    type: "rate_limit_event",
    rate_limit_info: info,
    uuid: "uuid-fixture",
    session_id: "se-1",
  }) as unknown as SDKMessage;

const unified = (fiveHour: number, sevenDay: number) =>
  rateLimitEvent({
    status: "allowed",
    resetsAt: FIVE_HOUR_RESET,
    rateLimitType: "five_hour",
    unifiedWindows: {
      five_hour: { utilization: fiveHour, resetsAt: FIVE_HOUR_RESET },
      seven_day: { utilization: sevenDay, resetsAt: SEVEN_DAY_RESET },
    },
  });

const NOW_MS = 1_700_000_000_000;

const FIVE_HOUR_RESET = 1_700_010_000;

const SEVEN_DAY_RESET = 1_700_300_000;
