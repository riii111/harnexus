import { classify, type WatchEvent } from "./classify.ts";
import type { WatchConfig } from "./config.ts";
import type { PrDetail } from "./github.ts";
import type { WatchState } from "./store.ts";

// The first read of a PR takes what is already on it as seen, so starting the watch never sends what the owner has handled.
export const nextEvents = (
  detail: PrDetail,
  state: WatchState,
  linkedAt: string,
  owner: string,
  config: WatchConfig,
) =>
  state.summary === null
    ? { events: [] as WatchEvent[], ...baselineOf(detail) }
    : eventsOf(detail, state, linkedAt, owner, config);

// Every comment is taken, findings or not, so one whose verdict changes later is still not new.
const baselineOf = (detail: PrDetail) => ({
  seen: [
    ...detail.comments.map((comment) => comment.id),
    ...(reviewCompleted(detail) ? [reviewKey(detail.head)] : []),
    ...detail.failedRequired.map((check) => checkKey(detail.head, check.name)),
  ],
  conflictHead: detail.mergeable === "CONFLICTING" ? detail.head : null,
});

// Events are told apart from what was already queued or sent by their keys, so a later read never repeats one.
// The owner's own account is fixed per repository, so its comments are known without another request.
const eventsOf = (
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
  const key = reviewKey(detail.head);
  if (
    detail.coderabbit === null ||
    !reviewCompleted(detail) ||
    !fresh(detail.coderabbit.createdAt) ||
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

const reviewCompleted = ({ coderabbit }: PrDetail) =>
  coderabbit !== null &&
  coderabbit.state === "SUCCESS" &&
  coderabbit.description.includes(REVIEW_COMPLETED);

const REVIEW_COMPLETED = "Review completed";

const reviewKey = (head: string) => `coderabbit:${head}`;

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
    const key = checkKey(detail.head, check.name);
    if (seen.has(key)) return [];

    seen.add(key);
    return [{ type: "ci_failed", head: detail.head, check }];
  });

const checkKey = (head: string, name: string) => `ci:${head}:${name}`;
