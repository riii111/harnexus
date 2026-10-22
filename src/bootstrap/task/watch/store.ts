import { createHash } from "node:crypto";
import { join } from "node:path";
import { Result } from "better-result";
import { isDirectory } from "../../../runtime/fs.boundary.ts";
import { isObject } from "../../../runtime/object.ts";
import type { Fields, TaskFailed } from "../format.ts";
import type { Env } from "../request.ts";
import { load, namesIn, type SaveJson, stateRoot } from "../session.ts";
import type { Finding, WatchEvent } from "./classify.ts";
import type { PrRef, PrSummary } from "./github.ts";

export type PrLink = PrRef & { url: string; worker: string; linkedAt: string };

// The watch reaches GitHub only, so a PR on another host is named but never linked.
export const githubPr = (value: string) => {
  const matched = GITHUB_PR.exec(value);
  if (matched === null) return null;

  const [, owner, name, number] = matched;
  return {
    repo: `${owner}/${name}`,
    number: Number(number),
    url: `https://github.com/${owner}/${name}/pull/${number}`,
  };
};

const GITHUB_PR =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:[/?#]\S*)?$/;

export const recordLink = (env: Env, save: SaveJson, link: PrLink) =>
  save(join(prDir(env, link), "link.json"), link, { exclusive: false });

// An unreadable link is skipped, so one broken record cannot stop the watch of every other PR.
export const listLinks = (env: Env) =>
  Result.gen(async function* () {
    const root = watchRoot(env);
    const links: PrLink[] = [];
    for (const key of (yield* Result.await(namesIn(root))).sort()) {
      if (!(await isDirectory(join(root, key)))) continue;

      const loaded = await load(join(root, key, "link.json"));
      const link = linkOf(loaded.isOk() ? loaded.value : null);
      if (link !== null) links.push(link);
    }
    return Result.ok(links);
  });

const linkOf = (value: unknown): PrLink | null =>
  isObject(value) &&
  typeof value.repo === "string" &&
  typeof value.number === "number" &&
  typeof value.url === "string" &&
  typeof value.worker === "string" &&
  typeof value.linkedAt === "string"
    ? {
        repo: value.repo,
        number: value.number,
        url: value.url,
        worker: value.worker,
        linkedAt: value.linkedAt,
      }
    : null;

export type WatchState = {
  status: "watching" | "draft" | "ended" | "stopped" | "halted";
  reason: string | null;
  summary: PrSummary | null;
  checkedAt: string | null;
  changedAt: string | null;
  // Keys of every event already queued or sent, so none is sent twice.
  seen: string[];
  pending: WatchEvent[];
  followUp: Finding[];
  conflictHead: string | null;
  delivered: Delivered | null;
  // The message whose delivery could not be confirmed; nothing more is sent for the PR until it is released.
  halted: Fields | null;
};

export type Delivered = {
  at: string;
  sender: string;
  prompt: string;
  findings: Finding[];
  followUp: boolean;
};

export const freshState = (): WatchState => ({
  status: "watching",
  reason: null,
  summary: null,
  checkedAt: null,
  changedAt: null,
  seen: [],
  pending: [],
  followUp: [],
  conflictHead: null,
  delivered: null,
  halted: null,
});

export const loadWatchState = (env: Env, ref: PrRef) =>
  Result.gen(async function* () {
    const loaded = yield* Result.await(load(statePath(env, ref)));
    return Result.ok<WatchState>(
      isObject(loaded)
        ? { ...freshState(), ...(loaded as Partial<WatchState>) }
        : freshState(),
    );
  });

export const saveWatchState = (
  env: Env,
  save: SaveJson,
  ref: PrRef,
  state: WatchState,
): Promise<Result<void, TaskFailed>> =>
  save(statePath(env, ref), state, { exclusive: false });

export const lockPath = (env: Env) => join(watchRoot(env), "watch.lock");

const statePath = (env: Env, ref: PrRef) => join(prDir(env, ref), "state.json");

// Keyed by the PR, so the latest worker to name it is the one told about it.
const prDir = (env: Env, ref: PrRef) =>
  join(
    watchRoot(env),
    createHash("sha256")
      .update(`${ref.repo.toLowerCase()}#${ref.number}`)
      .digest("hex")
      .slice(0, 16),
  );

const watchRoot = (env: Env) => join(stateRoot(env), "watch");
