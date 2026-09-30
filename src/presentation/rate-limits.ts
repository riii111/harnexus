import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isObject } from "../runtime/object.ts";

// utilization is a fraction of the window and resetsAt is in Unix seconds, as rate_limit_event reports them.
export type ClaudeLimits = {
  readonly fiveHour: UsedWindow | null;
  readonly sevenDay: UsedWindow | null;
};

export const NO_LIMITS: ClaudeLimits = { fiveHour: null, sevenDay: null };

// The limits are the account's, so an event from any thread's turn replaces what an earlier one reported.
// Model-specific weekly limits such as seven_day_opus are left out, since only one weekly window fits the entry and it holds the limit every model shares.
export const recordRateLimits = (
  limits: ClaudeLimits,
  message: SDKMessage,
): ClaudeLimits => {
  if (message.type !== "rate_limit_event") return limits;
  const info = message.rate_limit_info;
  const reported = { ...limits };
  const named = usedWindow(info);
  if (info.rateLimitType === "five_hour" && named !== null) {
    reported.fiveHour = named;
  }
  if (info.rateLimitType === "seven_day" && named !== null) {
    reported.sevenDay = named;
  }
  // The CLI also sends both windows under an undocumented unifiedWindows, the only place their usage shows while no limit is near; it is read when present and ignored otherwise.
  const windows =
    "unifiedWindows" in info && isObject(info.unifiedWindows)
      ? info.unifiedWindows
      : {};
  return {
    fiveHour: usedWindow(windows.five_hour) ?? reported.fiveHour,
    sevenDay: usedWindow(windows.seven_day) ?? reported.sevenDay,
  };
};

// A window past its reset no longer describes the account, so it is dropped, and with no window left there is no entry.
export const renderClaudeLimits = (limits: ClaudeLimits, nowMs: number) => {
  const nowSeconds = nowMs / 1000;
  const primary = appWindow(limits.fiveHour, FIVE_HOURS_MINS, nowSeconds);
  const secondary = appWindow(limits.sevenDay, SEVEN_DAYS_MINS, nowSeconds);
  if (primary === null && secondary === null) return null;
  return {
    limitId: CLAUDE_LIMIT_ID,
    limitName: "Claude",
    normalModelSlug: null,
    primary,
    secondary,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
  };
};

// Only the multi-bucket view gains the entry: the top-level rateLimits is Codex's own, and a response without the view is left as it is so Codex's limits are not shown as missing.
export const withClaudeLimits = (
  result: Record<string, unknown>,
  snapshot: NonNullable<ReturnType<typeof renderClaudeLimits>>,
) => {
  const byLimitId = result.rateLimitsByLimitId;
  if (!isObject(byLimitId)) return { result, collision: false };
  if (CLAUDE_LIMIT_ID in byLimitId) return { result, collision: true };
  return {
    result: {
      ...result,
      rateLimitsByLimitId: { ...byLimitId, [CLAUDE_LIMIT_ID]: snapshot },
    },
    collision: false,
  };
};

type UsedWindow = { readonly utilization: number; readonly resetsAt: number };

// The app counts usedPercent from 0 to 100 and resetsAt in Unix seconds.
const appWindow = (
  window: UsedWindow | null,
  windowDurationMins: number,
  nowSeconds: number,
) =>
  window === null || window.resetsAt <= nowSeconds
    ? null
    : {
        usedPercent: Math.round(window.utilization * 100),
        windowDurationMins,
        resetsAt: window.resetsAt,
      };

const usedWindow = (value: unknown): UsedWindow | null =>
  isObject(value) &&
  typeof value.utilization === "number" &&
  typeof value.resetsAt === "number"
    ? { utilization: value.utilization, resetsAt: value.resetsAt }
    : null;

const CLAUDE_LIMIT_ID = "claude";

const FIVE_HOURS_MINS = 5 * 60;

const SEVEN_DAYS_MINS = 7 * 24 * 60;
