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

// Only the link is written here; the running watch is the one writer of a PR's state, and it notices the new chat itself.
export const recordLink = (root: string, link: PrLink) =>
  saveJson(linkPath(root, link), link);

// The chat a PR is linked to, since when, and whether its watch still runs, for a caller deciding whether to take the PR over.
// A stopped or halted watch cannot reach its chat, so another chat may take the PR.
export const linkedChat = (root: string, ref: PrRef) =>
  Result.gen(async function* () {
    const link = linkOf(yield* Result.await(loadJson(linkPath(root, ref))));
    if (link === null) return Result.ok(null);
    const state = yield* Result.await(loadWatchState(root, ref));
    return Result.ok({
      worker: link.worker,
      linkedAt: link.linkedAt,
      active: state.status === "watching" || state.status === "draft",
    });
  });

const linkPath = (root: string, ref: PrRef) =>
  join(root, keyOf(ref), "link.json");

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
  // The chat the delivery fields belong to; a different chat in the link means the PR was handed over.
  worker: string | null;
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
  worker: null,
  halted: null,
});

// No command brings an ended PR back, so a watch may stop reading it for as long as it runs.
// A stopped one is left readable, since naming it from another worker resumes it.
export const isOver = (state: WatchState) => state.status === "ended";

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
// Its CodeRabbit key is taken as the bot already known, so the watch does not read CodeRabbit as newly added.
const upgraded = (state: WatchState): WatchState => ({
  ...state,
  summary: state.summary === null ? null : upgradedSummary(state.summary),
  seen:
    state.summary !== null && !state.seen.some((key) => key.startsWith(BOT_KEY))
      ? [...state.seen, botKey("coderabbit")]
      : state.seen,
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

const upgradedSummary = (summary: PrSummary): PrSummary => {
  const { coderabbit, ...rest } = summary as PrSummary & {
    coderabbit?: PrSummary["bots"][string];
  };
  return "bots" in summary
    ? summary
    : { ...rest, bots: { coderabbit: coderabbit ?? null } };
};

// Marks a bot whose reviews the watch has taken in, so one added to the config later starts from what it already did.
export const botKey = (id: string) => `${BOT_KEY}${id}`;

const BOT_KEY = "bot:";

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

// The chat the watch sends from to a worker that has no sender of its own, such as a chat the owner started by hand.
export const recordSender = (root: string, thread: string) =>
  saveJson(senderPath(root), { thread, at: new Date().toISOString() });

export const loadSender = (root: string) =>
  Result.gen(async function* () {
    const loaded = yield* Result.await(loadJson(senderPath(root)));
    return Result.ok(
      isObject(loaded) && typeof loaded.thread === "string"
        ? loaded.thread
        : null,
    );
  });

const senderPath = (root: string) => join(root, "sender.json");

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
