import { classify, type WatchEvent } from "./classify.ts";
import type { WatchConfig } from "./config.ts";
import type { PrDetail } from "./github.ts";
import type { WatchState } from "./store.ts";

// Events are told apart from what was already queued or sent by their keys, so a later read never repeats one.
// The owner's own account is fixed per repository, so its comments are known without another request.
export const eventsOf = (
  detail: PrDetail,
  state: WatchState,
  linkedAt: string,
  owner: string,
  config: WatchConfig,
) => {
  const seen = new Set(state.seen);
  const after = Date.parse(linkedAt);
  const fresh = (time: string) => Date.parse(time) >= after;

  const findings = newFindings(detail, seen, fresh, owner, config);
  const done = reviewDone(detail, seen, fresh, findings);
  const conflict = conflictOf(detail, state.conflictHead);
  const failed = failedChecks(detail, seen);

  return {
    events: [...done, ...findings, ...conflict.events, ...failed],
    seen: [...seen],
    conflictHead: conflict.head,
  };
};

const newFindings = (
  detail: PrDetail,
  seen: Set<string>,
  fresh: (time: string) => boolean,
  owner: string,
  config: WatchConfig,
) => {
  // CodeRabbit's findings wait for its review to complete, so they arrive with it in one message.
  const reviewing = detail.coderabbit?.state === "PENDING";
  const events: WatchEvent[] = [];
  for (const verdict of classify(detail.comments, owner, config.ignore)) {
    if (!("finding" in verdict)) continue;

    const { finding } = verdict;
    if (finding.coderabbit && reviewing) continue;
    if (!fresh(finding.createdAt) || seen.has(finding.id)) continue;

    seen.add(finding.id);
    events.push({ type: "finding", finding });
  }
  return events;
};

const reviewDone = (
  detail: PrDetail,
  seen: Set<string>,
  fresh: (time: string) => boolean,
  findings: readonly WatchEvent[],
): WatchEvent[] => {
  const status = detail.coderabbit;
  const key = `coderabbit:${detail.head}`;
  if (
    status === null ||
    status.state !== "SUCCESS" ||
    !status.description.includes(REVIEW_COMPLETED) ||
    !fresh(status.createdAt) ||
    seen.has(key)
  )
    return [];

  seen.add(key);
  // Whether the review found anything is decided by its new inline findings; the summary comment only confirms it.
  const inline = findings.filter(
    (event) =>
      event.type === "finding" &&
      event.finding.coderabbit &&
      event.finding.kind === "inline",
  ).length;
  return [
    {
      type: "coderabbit_done",
      head: detail.head,
      findings: inline,
      summaryAgrees: (inline === 0) === detail.noActionableSummary,
    },
  ];
};

const REVIEW_COMPLETED = "Review completed";

// Told once per head while the PR conflicts, so a base that keeps moving does not repeat it.
const conflictOf = (detail: PrDetail, notified: string | null) => {
  if (detail.mergeable === "CONFLICTING" && notified !== detail.head)
    return {
      events: [{ type: "conflict", head: detail.head } satisfies WatchEvent],
      head: detail.head,
    };
  return {
    events: [],
    head: detail.mergeable === "MERGEABLE" ? null : notified,
  };
};

const failedChecks = (detail: PrDetail, seen: Set<string>) =>
  detail.failedRequired.flatMap((check): WatchEvent[] => {
    const key = `ci:${detail.head}:${check.name}`;
    if (seen.has(key)) return [];

    seen.add(key);
    return [{ type: "ci_failed", head: detail.head, check }];
  });
