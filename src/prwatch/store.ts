import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Result } from "better-result";
import {
  isDirectory,
  listDirectoryIfExists,
  prepareDirectory,
  readTextFileIfExists,
  writeFileAtomic,
} from "../runtime/fs.boundary.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import type { Finding } from "./classify.ts";
import type { WatchEvent } from "./events.ts";
import { type Fields, ioFailed, WatchFailed } from "./failure.ts";
import type { PrRef, PrSummary } from "./github.ts";

// Every path below is under the root the caller gives, so the watch never decides where its records live.
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

export const samePr = (a: PrRef, b: PrRef) =>
  a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;

export const recordLink = (root: string, link: PrLink) =>
  saveJson(join(root, keyOf(link), "link.json"), link);

// An unreadable link is skipped, so one broken record cannot stop the watch of every other PR.
// The keys in skip are not read at all, which spares the watch every PR it has finished with.
export const listLinks = (root: string, skip: ReadonlySet<string> = EMPTY) =>
  Result.gen(async function* () {
    const names = yield* Result.await(
      listDirectoryIfExists(root).then((listed) => listed.mapError(ioFailed)),
    );
    const links: PrLink[] = [];
    for (const key of (names ?? []).sort()) {
      if (skip.has(key) || !(await isDirectory(join(root, key)))) continue;

      const loaded = await loadJson(join(root, key, "link.json"));
      const link = linkOf(loaded.isOk() ? loaded.value : null);
      if (link !== null) links.push(link);
    }
    return Result.ok(links);
  });

const EMPTY: ReadonlySet<string> = new Set();

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

// No command brings these back, so a watch may stop reading them for as long as it runs.
export const isOver = (state: WatchState) =>
  state.status === "ended" || state.status === "stopped";

export const loadWatchState = (root: string, ref: PrRef) =>
  Result.gen(async function* () {
    const loaded = yield* Result.await(loadJson(statePath(root, ref)));
    return Result.ok<WatchState>(
      isObject(loaded)
        ? upgraded({ ...freshState(), ...(loaded as Partial<WatchState>) })
        : freshState(),
    );
  });

// A state written before review bots were configurable names CodeRabbit in its own fields; it is read as the coderabbit preset.
const upgraded = (state: WatchState): WatchState => ({
  ...state,
  pending: state.pending.map(upgradedEvent),
  followUp: state.followUp.map(upgradedFinding),
  delivered:
    state.delivered === null
      ? null
      : {
          ...state.delivered,
          findings: state.delivered.findings.map(upgradedFinding),
        },
});

const upgradedEvent = (event: WatchEvent): WatchEvent => {
  const old = event as WatchEvent | (Fields & { type: "coderabbit_done" });
  if (old.type === "coderabbit_done")
    return {
      type: "review_done",
      bot: "coderabbit",
      name: "CodeRabbit",
      head: String(old.head),
      findings: Number(old.findings),
      summaryAgrees: old.summaryAgrees === true,
    };
  return old.type === "finding"
    ? { ...old, finding: upgradedFinding(old.finding) }
    : old;
};

const upgradedFinding = (finding: Finding): Finding => {
  if (finding.bot !== undefined) return finding;

  const { coderabbit, ...rest } = finding as Finding & { coderabbit?: boolean };
  return { ...rest, bot: coderabbit === true ? "coderabbit" : null };
};

export const saveWatchState = (
  root: string,
  ref: PrRef,
  state: WatchState,
): Promise<Result<void, WatchFailed>> => saveJson(statePath(root, ref), state);

export const lockPath = (root: string) => join(root, "watch.lock");

const statePath = (root: string, ref: PrRef) =>
  join(root, keyOf(ref), "state.json");

// Keyed by the PR, so the latest worker to name it is the one told about it.
export const keyOf = (ref: PrRef) =>
  createHash("sha256")
    .update(`${ref.repo.toLowerCase()}#${ref.number}`)
    .digest("hex")
    .slice(0, 16);

const loadJson = (path: string) =>
  Result.gen(async function* () {
    const text = yield* Result.await(
      readTextFileIfExists(path).then((read) => read.mapError(ioFailed)),
    );
    if (text === null) return Result.ok(null);
    return parseJson(text).mapError(
      () => new WatchFailed({ message: `${path} is not valid JSON` }),
    );
  });

// Indented by one space like the other harnexus-task records, so the files read alike.
const saveJson = (path: string, data: unknown) =>
  Result.gen(async function* () {
    yield* Result.await(
      prepareDirectory(dirname(path)).then((made) => made.mapError(ioFailed)),
    );
    yield* Result.await(
      writeFileAtomic(path, JSON.stringify(data, null, 1)).then((written) =>
        written.mapError(ioFailed),
      ),
    );
    return Result.ok();
  });
