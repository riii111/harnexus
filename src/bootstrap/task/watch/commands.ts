import { dirname } from "node:path";
import { Result } from "better-result";
import {
  prepareDirectory,
  readTextFileIfExists,
  writeFileAtomic,
  writeFileExclusive,
} from "../../../runtime/fs.boundary.ts";
import { parseJson } from "../../../runtime/json.boundary.ts";
import { isObject } from "../../../runtime/object.ts";
import { processExists } from "../../../runtime/process.boundary.ts";
import { type Fields, fail, type TaskFailed } from "../format.ts";
import { type Env, ioFailed, NAME } from "../request.ts";
import type { SaveJson } from "../session.ts";
import { classify, messageOf, type Verdict } from "./classify.ts";
import { configPath, loadConfig, type WatchConfig } from "./config.ts";
import { eventsOf } from "./events.ts";
import type { GitHub, PrDetail, PrRef } from "./github.ts";
import {
  freshState,
  githubPr,
  listLinks,
  loadWatchState,
  lockPath,
  saveWatchState,
} from "./store.ts";
import { runCycle, type WatchDeps } from "./watcher.ts";

// Runs until stopped; a failed cycle is logged and retried, so a config or network error never ends the watch.
export const watchForever = (
  deps: WatchDeps,
  sleep: (ms: number) => Promise<unknown>,
) =>
  Result.gen(async function* () {
    yield* Result.await(acquireLock(deps.env));
    deps.log({ event: "started", pid: process.pid });

    for (;;) {
      const cycle = await runCycle(deps);
      if (cycle.isErr())
        deps.log({ event: "cycle_failed", error: cycle.error.message });
      await sleep(
        cycle.isOk() ? cycle.value.pollIntervalSeconds * 1000 : RETRY_MS,
      );
    }
  });

const RETRY_MS = 60_000;

// One watch at a time, so two never send the same event; a lock left by a watch that died is taken over.
const acquireLock = (env: Env): Promise<Result<void, TaskFailed>> =>
  Result.gen(async function* () {
    const path = lockPath(env);
    yield* Result.await(io(prepareDirectory(dirname(path))));

    const content = JSON.stringify({ pid: process.pid });
    if (yield* Result.await(io(writeFileExclusive(path, content))))
      return Result.ok();

    const held = parseJson(
      (yield* Result.await(io(readTextFileIfExists(path)))) ?? "",
    );
    const pid = held.isOk() && isObject(held.value) ? held.value.pid : null;
    if (typeof pid === "number" && pid !== process.pid && processExists(pid))
      return fail(`another ${NAME} watch runs as pid ${pid}`);

    yield* Result.await(io(writeFileAtomic(path, content)));
    return Result.ok();
  });

const io = async <T>(
  pending: Promise<Result<T, { message: string; cause?: unknown }>>,
): Promise<Result<T, TaskFailed>> => (await pending).mapError(ioFailed);

// Reads every comment as if the PR had just been linked, so the verdicts can be checked against GitHub before anything is sent.
export const dryRun = (
  deps: { env: Env; github: GitHub },
  urls: readonly string[],
) =>
  Result.gen(async function* () {
    const config = yield* Result.await(loadConfig(configPath(deps.env)));
    const refs = yield* Result.await(dryRunTargets(deps.github, config, urls));

    const reports: Fields[] = [];
    for (const ref of refs) {
      const account = yield* accountFor(config, ref.repo);
      const detail = yield* Result.await(deps.github.detail(account, ref));
      reports.push(reportOf(detail, account, config));
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

const reportOf = (detail: PrDetail, account: string, config: WatchConfig) => {
  const verdicts = classify(detail.comments, account, config.ignore);
  const { events } = eventsOf(
    detail,
    freshState(),
    new Date(0).toISOString(),
    account,
    config,
  );

  return {
    pr: detail.url,
    title: detail.title,
    draft: detail.isDraft,
    head: detail.head,
    coderabbit: detail.coderabbit,
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
export const release = (env: Env, save: SaveJson, url: string) =>
  Result.gen(async function* () {
    const ref = githubPr(url);
    if (ref === null)
      return fail("--release must be a GitHub pull request URL");

    const links = yield* Result.await(listLinks(env));
    const link = links.find(
      (each) =>
        each.repo.toLowerCase() === ref.repo.toLowerCase() &&
        each.number === ref.number,
    );
    if (link === undefined) return fail(`${ref.url} is not linked to a worker`);

    const state = yield* Result.await(loadWatchState(env, link));
    if (state.status !== "halted") return fail(`${ref.url} is not halted`);

    yield* Result.await(
      saveWatchState(env, save, link, {
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
