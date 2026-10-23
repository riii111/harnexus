import { Result } from "better-result";
import { holdProcessLock, prepareDirectory } from "../runtime/fs.boundary.ts";
import { classify, type Verdict } from "./classify.ts";
import { loadConfig, type WatchConfig } from "./config.ts";
import { nextEvents } from "./events.ts";
import { type Fields, fail, ioFailed, type WatchFailed } from "./failure.ts";
import type { GitHub, PrDetail, PrRef } from "./github.ts";
import { messageOf } from "./message.ts";
import {
  freshState,
  githubPr,
  listLinks,
  loadSender,
  loadWatchState,
  lockPath,
  samePr,
  saveWatchState,
  type WatchState,
} from "./store.ts";
import { runCycle, type WatchDeps, type WatchPaths } from "./watcher.ts";

// Runs until stopped; a failed cycle is logged and retried, so a config or network error never ends the watch.
// Between cycles the process only sleeps on a timer.
// Once its program has been replaced it ends between cycles, never mid-send, so the service that keeps it running starts the new one.
export const watchForever = (
  deps: WatchDeps,
  sleep: (ms: number) => Promise<unknown>,
  replaced: () => Promise<boolean> = async () => false,
) =>
  Result.gen(async function* () {
    yield* Result.await(acquireLock(deps.paths.state));
    deps.log({ event: "started", pid: process.pid });

    const cycleDeps = { ...deps, over: deps.over ?? new Set<string>() };
    for (;;) {
      // Checked before each cycle, so no cycle runs on a program replaced while the watch slept.
      if (await replaced()) {
        deps.log({ event: "replaced" });
        return fail(
          "the watch's program was replaced; exiting to be restarted",
        );
      }
      const cycle = await runCycle(cycleDeps);
      if (cycle.isErr())
        deps.log({ event: "cycle_failed", error: cycle.error.message });
      await sleep(
        cycle.isOk() ? cycle.value.pollIntervalSeconds * 1000 : RETRY_MS,
      );
    }
  });

const RETRY_MS = 60_000;

// One watch at a time, so two never send the same event.
const acquireLock = (root: string): Promise<Result<void, WatchFailed>> =>
  Result.gen(async function* () {
    yield* Result.await(prepareDirectory(root).then(io));

    const held = yield* io(holdProcessLock(lockPath(root)));
    return held ? Result.ok() : fail("another PR watch is running");
  });

const io = <T>(
  result: Result<T, { message: string; cause?: unknown }>,
): Result<T, WatchFailed> => result.mapError(ioFailed);

// Decides from each PR's saved watch state as the watch would, but writes none, so a run before starting shows what the first cycle sends.
export const dryRun = (
  deps: { paths: WatchPaths; github: GitHub },
  urls: readonly string[],
) =>
  Result.gen(async function* () {
    const config = yield* Result.await(loadConfig(deps.paths.config));
    const refs = yield* Result.await(dryRunTargets(deps.github, config, urls));
    const links = yield* Result.await(listLinks(deps.paths.state));

    const reports: Fields[] = [];
    for (const ref of refs) {
      const account = yield* accountFor(config, ref.repo);
      const link = links.find((each) => samePr(each, ref));
      const state =
        link === undefined
          ? freshState()
          : yield* Result.await(loadWatchState(deps.paths.state, link));
      const detail = yield* Result.await(
        deps.github.detail(account, ref, config.reviewBots),
      );
      reports.push(
        reportOf(detail, state, link?.linkedAt ?? EPOCH, account, config),
      );
    }
    return Result.ok<Fields>({ dryRun: true, prs: reports });
  });

// Without --pr, the open PRs each account wrote in the configured repositories.
const dryRunTargets = (
  github: GitHub,
  config: WatchConfig,
  urls: readonly string[],
) =>
  Result.gen(async function* () {
    const refs: PrRef[] = [];
    for (const url of urls) {
      const ref = githubPr(url);
      if (ref === null) return fail("--pr must be a GitHub pull request URL");
      refs.push(ref);
    }
    if (urls.length > 0) return Result.ok(refs);

    for (const [repo, { account }] of Object.entries(config.repositories))
      refs.push(...(yield* Result.await(github.openPulls(account, repo))));
    return Result.ok(refs);
  });

const accountFor = (config: WatchConfig, repo: string) => {
  const account = config.repositories[repo.toLowerCase()]?.account;
  return account === undefined
    ? fail(`${repo} is not in the repositories of the watch config`)
    : Result.ok(account);
};

// A PR no watch has linked has no state, so it is shown as read for the first time and its link time is never used.
const EPOCH = new Date(0).toISOString();

const reportOf = (
  detail: PrDetail,
  state: WatchState,
  linkedAt: string,
  account: string,
  config: WatchConfig,
) => {
  const verdicts = classify(
    detail.comments,
    account,
    config.ignore,
    config.reviewBots,
  );
  const { events } = nextEvents(detail, state, linkedAt, account, config);

  return {
    pr: detail.url,
    title: detail.title,
    draft: detail.isDraft,
    firstRead: state.summary === null,
    head: detail.head,
    bots: detail.bots,
    mergeable: detail.mergeable,
    failedRequired: detail.failedRequired,
    notified: verdicts.flatMap((verdict) =>
      "finding" in verdict ? [verdict.finding] : [],
    ),
    ignored: verdicts.flatMap(ignoredOf),
    prompt:
      detail.isDraft || events.length === 0
        ? null
        : messageOf(detail.url, events),
  };
};

const ignoredOf = (verdict: Verdict) =>
  "ignored" in verdict
    ? [
        {
          id: verdict.comment.id,
          author: verdict.comment.author,
          kind: verdict.comment.kind,
          reason: verdict.ignored,
          url: verdict.comment.url,
        },
      ]
    : [];

// Releasing takes the halted message as delivered, since the owner checked the app and it must never be sent again.
export const release = (root: string, url: string) =>
  Result.gen(async function* () {
    const ref = githubPr(url);
    if (ref === null)
      return fail("--release must be a GitHub pull request URL");

    const links = yield* Result.await(listLinks(root));
    const link = links.find((each) => samePr(each, ref));
    if (link === undefined) return fail(`${ref.url} is not linked to a worker`);

    const state = yield* Result.await(loadWatchState(root, link));
    if (state.status !== "halted") return fail(`${ref.url} is not halted`);

    yield* Result.await(
      saveWatchState(root, link, {
        ...state,
        status: "watching",
        reason: null,
        pending: [],
        followUp: [],
        delivered: null,
        halted: null,
      }),
    );
    return Result.ok<Fields>({ released: ref.url, worker: link.worker });
  });

// What each linked PR's watch is doing, read from the records alone, so it works whether or not a watch runs.
export const status = (root: string) =>
  Result.gen(async function* () {
    const prs: Fields[] = [];
    for (const link of yield* Result.await(listLinks(root))) {
      // An unreadable record is shown as such, as the watch logs and skips it.
      const loaded = await loadWatchState(root, link);
      if (loaded.isErr()) {
        prs.push({
          pr: link.url,
          worker: link.worker,
          status: "unreadable",
          reason: loaded.error.message,
        });
        continue;
      }
      const state = loaded.value;
      prs.push({
        pr: link.url,
        worker: link.worker,
        status: state.status,
        reason: state.reason,
        pending: state.pending.length,
        followUp: state.followUp.length,
        awaitingAnswer: state.delivered !== null,
        checkedAt: state.checkedAt,
      });
    }
    const sender = yield* Result.await(loadSender(root));
    return Result.ok<Fields>({ sender, prs });
  });
