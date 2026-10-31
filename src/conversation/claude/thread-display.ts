import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  NO_PLAN,
  renderPlan,
  type ThreadPlan,
} from "../../presentation/plan.ts";
import {
  NO_USAGE,
  renderTokenUsage,
  type ThreadUsage,
} from "../../presentation/token-usage.ts";

// What the app shows of a thread beyond its turns builds up across turns, so it lives per thread rather than per session.
export const createThreadDisplay = ({
  send,
  now,
}: {
  send: (message: object) => void;
  now: () => number;
}) => {
  const usages = new Map<string, ThreadUsage>();
  const plans = new Map<string, ThreadPlan>();

  const show = (
    turn: { threadId: string; turnId: string; model: string },
    message: SDKMessage,
  ) => {
    const { threadId, turnId, model } = turn;
    const usage = renderTokenUsage(usages.get(threadId) ?? NO_USAGE, message, {
      threadId,
      turnId,
      model,
      now: now(),
    });
    usages.set(threadId, usage.usage);
    if (usage.notification !== null) send(usage.notification);
    const plan = renderPlan(plans.get(threadId) ?? NO_PLAN, message, {
      threadId,
      turnId,
      now: now(),
    });
    plans.set(threadId, plan.plan);
    if (plan.notification !== null) send(plan.notification);
  };

  return { show };
};
