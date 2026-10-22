import { Result } from "better-result";
import { type Fields, jsonEqual } from "../format.ts";
import type { Env } from "../request.ts";
import type { SaveJson } from "../session.ts";
import {
  type Finding,
  followUpOf,
  messageOf,
  missingFrom,
  type WatchEvent,
} from "./classify.ts";
import { configPath, loadConfig, type WatchConfig } from "./config.ts";
import { eventsOf } from "./events.ts";
import type { GitHub, PrSummary } from "./github.ts";
import {
  listLinks,
  loadWatchState,
  type PrLink,
  saveWatchState,
  type WatchState,
} from "./store.ts";
import {
  type AppCall,
  answerTo,
  busyReason,
  readThread,
  senderOf,
} from "./worker-thread.ts";

export type WatchDeps = {
  env: Env;
  saveJson: SaveJson;
  github: GitHub;
  callApp: AppCall;
  now: () => Date;
  log: (entry: Fields) => void;
};

// One pass: poll the PRs that are due, queue what changed, then deliver to every worker that can take a message now.
export const runCycle = (deps: WatchDeps) =>
  Result.gen(async function* () {
    const config = yield* Result.await(loadConfig(configPath(deps.env)));
    const links = yield* Result.await(listLinks(deps.env));
    const now = deps.now();

    const entries: Entry[] = [];
    for (const link of links) {
      const entry = yield* Result.await(openEntry(deps, config, link));
      if (entry !== null) entries.push(entry);
    }

    for (const [account, due] of dueByAccount(entries, now, config))
      await pollAccount(deps, config, account, due, now);

    for (const entry of entries) {
      await deliver(deps, config, entry, now);
      if (!jsonEqual(entry.before, entry.state))
        yield* Result.await(
          saveWatchState(deps.env, deps.saveJson, entry.link, entry.state),
        );
    }
    return Result.ok(config);
  });

type Entry = {
  link: PrLink;
  state: WatchState;
  account: string;
  // What is on disk, so a state is written only when the cycle changed it.
  before: WatchState;
};

const openEntry = (deps: WatchDeps, config: WatchConfig, link: PrLink) =>
  Result.gen(async function* () {
    const loaded = await loadWatchState(deps.env, link);
    if (loaded.isErr()) {
      deps.log({
        event: "state_unreadable",
        pr: link.url,
        error: loaded.error.message,
      });
      return Result.ok(null);
    }

    const state = loaded.value;
    if (FINISHED.includes(state.status)) return Result.ok(null);

    const before = structuredClone(state);
    const account = config.repositories[link.repo.toLowerCase()]?.account;
    if (account === undefined) {
      state.reason = "repository is not configured";
      if (!jsonEqual(before, state))
        yield* Result.await(
          saveWatchState(deps.env, deps.saveJson, link, state),
        );
      return Result.ok(null);
    }
    return Result.ok<Entry | null>({ link, state, account, before });
  });

// A halted PR waits for the owner to release it; the others are over for good.
const FINISHED: readonly WatchState["status"][] = [
  "ended",
  "stopped",
  "halted",
];

const dueByAccount = (
  entries: readonly Entry[],
  now: Date,
  config: WatchConfig,
) => {
  const due = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!isDue(entry.state, now, config)) continue;
    due.set(entry.account, [...(due.get(entry.account) ?? []), entry]);
  }
  return due;
};

const isDue = (state: WatchState, now: Date, config: WatchConfig) =>
  since(state.checkedAt, now) + DUE_MARGIN_MS >= intervalMs(state, now, config);

// Timers drift by a few hundred milliseconds, so a PR due at this cycle is not left to the next one.
const DUE_MARGIN_MS = 5_000;

// A PR nothing has happened to for a while is polled less often.
const intervalMs = (state: WatchState, now: Date, config: WatchConfig) =>
  (since(state.changedAt, now) >= config.idleAfterHours * 3_600_000
    ? config.idleIntervalSeconds
    : config.pollIntervalSeconds) * 1000;

const pollAccount = async (
  deps: WatchDeps,
  config: WatchConfig,
  account: string,
  entries: Entry[],
  now: Date,
) => {
  const summaries = await deps.github.summaries(
    account,
    entries.map((entry) => entry.link),
  );
  if (summaries.isErr()) {
    deps.log({ event: "poll_failed", account, error: summaries.error.message });
    return;
  }

  for (const [index, entry] of entries.entries()) {
    const summary = summaries.value[index] ?? null;
    await applySummary(deps, config, entry, summary, now);
  }
};

const applySummary = async (
  deps: WatchDeps,
  config: WatchConfig,
  { link, state, account }: Entry,
  summary: PrSummary | null,
  now: Date,
) => {
  const pr = link.url;
  state.checkedAt = iso(now);
  if (summary === null) {
    deps.log({ event: "pr_unreadable", pr, account });
    return;
  }

  const changed = !jsonEqual(state.summary, summary);
  if (changed) state.changedAt = iso(now);
  if (summary.state !== "OPEN") {
    state.status = "ended";
    state.reason = summary.state.toLowerCase();
    state.summary = summary;
    deps.log({ event: "ended", pr, reason: state.reason });
    return;
  }
  if (summary.isDraft) {
    if (state.status !== "draft") deps.log({ event: "paused", pr });
    state.status = "draft";
    state.summary = summary;
    return;
  }

  const resumed = state.status === "draft";
  state.status = "watching";
  if (!changed && !resumed) return;
  if (resumed) deps.log({ event: "resumed", pr });

  const detail = await deps.github.detail(account, link);
  // The summary is left as it was, so the next cycle reads the detail again.
  if (detail.isErr()) {
    deps.log({ event: "detail_failed", pr, error: detail.error.message });
    return;
  }

  state.summary = summary;
  const found = eventsOf(detail.value, state, link.linkedAt, account, config);
  state.seen = found.seen;
  state.conflictHead = found.conflictHead;
  if (found.events.length === 0) return;

  state.pending.push(...found.events);
  deps.log({
    event: "queued",
    pr,
    kinds: found.events.map((event) => event.type),
  });
};

const deliver = async (
  deps: WatchDeps,
  config: WatchConfig,
  entry: Entry,
  now: Date,
) => {
  const { link, state } = entry;
  if (state.status !== "watching" || !hasWork(state)) return;

  const pr = link.url;
  const sender = await senderOf(deps.env, link.worker);
  if (sender === null) {
    if (state.reason !== NO_SENDER)
      deps.log({ event: "no_sender", pr, worker: link.worker });
    state.reason = NO_SENDER;
    return;
  }

  const view = await readThread(deps.callApp, sender, link.worker);
  if (view === null) return;
  if (view.gone) {
    state.status = "stopped";
    state.reason = "worker thread is gone";
    deps.log({ event: "stopped", pr, reason: state.reason });
    return;
  }
  state.reason = null;

  if (state.delivered !== null) {
    const checked = checkAnswer(deps, state, view.turns, pr, now);
    if (!checked) return;
  }

  if (state.pending.length === 0 && state.followUp.length === 0) return;
  if (inQuietHours(now, config.quietHours)) return;
  if (busyReason(view, now) !== null) return;

  await send(deps, entry, sender, now);
};

const hasWork = (state: WatchState) =>
  state.pending.length > 0 ||
  state.followUp.length > 0 ||
  state.delivered !== null;

const NO_SENDER = "no reviewer thread to send from";

// False while the answer to the last message is still to come, so a new message never interrupts it.
const checkAnswer = (
  deps: WatchDeps,
  state: WatchState,
  turns: Parameters<typeof answerTo>[0],
  pr: string,
  now: Date,
) => {
  const delivered = state.delivered;
  if (delivered === null) return true;

  const turn = answerTo(turns, delivered);
  if (turn === undefined) {
    if (since(delivered.at, now) < ANSWER_WAIT_MS) return false;
    deps.log({ event: "answer_not_seen", pr });
  } else if (turn.status === "inProgress") return false;
  // A turn that did not complete was stopped by the owner, who then has the conversation.
  else if (turn.status === "completed" && !delivered.followUp) {
    state.followUp = missingFrom(turn.answer, delivered.findings);
    if (state.followUp.length > 0)
      deps.log({
        event: "answer_incomplete",
        pr,
        missing: state.followUp.length,
      });
  }

  state.delivered = null;
  return true;
};

// An answer never seen in this long is given up on, so one lost turn cannot stop every later message to the worker.
const ANSWER_WAIT_MS = 24 * 3_600_000;

export const inQuietHours = (now: Date, quiet: WatchConfig["quietHours"]) => {
  if (quiet === null) return false;

  const minute = now.getHours() * 60 + now.getMinutes();
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  return start <= end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
};

const minutesOf = (clock: string) => {
  const [hours, minutes] = clock.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

const send = async (
  deps: WatchDeps,
  entry: Entry,
  sender: string,
  now: Date,
) => {
  const { link, state } = entry;
  const pr = link.url;
  // The follow-up goes alone and first, so it asks only about what the last answer left out.
  const followUp = state.followUp.length > 0;
  const prompt = followUp
    ? followUpOf(pr, state.followUp)
    : messageOf(pr, state.pending);
  const findings = followUp ? state.followUp : findingsOf(state.pending);

  // Recorded as halted before the call, so a watch stopped mid-send never sends the message again.
  const sending: WatchState = {
    ...state,
    status: "halted",
    halted: { at: iso(now), prompt, answer: null },
  };
  const marked = await saveWatchState(deps.env, deps.saveJson, link, sending);
  if (marked.isErr()) {
    deps.log({ event: "state_unwritable", pr, error: marked.error.message });
    return;
  }
  // Compared against the mark, so whatever the outcome the state is written again.
  entry.before = sending;

  // Taken just before the call, so a turn started while the cycle read GitHub is never taken for the answer.
  const sentAt = iso(deps.now());
  const answer = await deps.callApp(sender, "send_message_to_thread", {
    threadId: link.worker,
    prompt,
  });
  const outcome = String(answer.outcome);
  if (outcome === "done") {
    if (followUp) state.followUp = [];
    else state.pending = [];
    state.delivered = { at: sentAt, sender, prompt, findings, followUp };
    deps.log({
      event: "sent",
      pr,
      worker: link.worker,
      followUp,
      findings: findings.length,
    });
    return;
  }
  if (NOT_SENT.includes(outcome)) {
    deps.log({ event: "send_not_sent", pr, outcome });
    return;
  }

  // The message may have reached the worker, so it is never sent again on its own.
  state.status = "halted";
  state.halted = { at: iso(now), prompt, answer };
  deps.log({ event: "halted", pr, outcome });
};

const findingsOf = (events: readonly WatchEvent[]): Finding[] =>
  events.flatMap((event) => (event.type === "finding" ? [event.finding] : []));

// The outcomes harnexus-task already treats as never having reached the app.
const NOT_SENT = ["not_sent", "rejected", "invalid"];

const iso = (date: Date) => date.toISOString();

const since = (value: string | null, now: Date) =>
  value === null ? Number.POSITIVE_INFINITY : now.getTime() - Date.parse(value);
