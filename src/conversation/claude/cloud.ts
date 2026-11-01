import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { matchError, Result, TaggedError } from "better-result";
import {
  type CloudCopyFailure,
  type CloudSendFailure,
  parseCloudSessionId,
} from "../../infra/claude/cloud.ts";
import type { CloudLink } from "../../infra/thread-store.ts";
import {
  endsTurn,
  mainRecords,
  renderRecords,
  timeOf,
  turnOpeningTextOf,
} from "../../presentation/history.ts";
import { renderNotice } from "../../presentation/turn.ts";
import { isObject } from "../../runtime/object.ts";
import { createSerialQueue } from "../../runtime/serial-queue.ts";
import type { TurnEvent } from "../controller.ts";
import { type Refusal, refusalMessage } from "../thread-request.ts";
import type { ThreadValues } from "../thread-values.ts";
import type { RunningTurn, TurnInput, TurnRuntime } from "../turn-runtime.ts";
import { type CloudChild, childSessionsIn } from "./cloud-children.ts";
import { type CloudReview, reviewsIn } from "./cloud-reviews.ts";
import { sessionCommandTextOf } from "./runtime.ts";
import { createTurnRecords } from "./turn-records.ts";

// A Cloud thread's turns log their failure tags beside the Claude runtime's, so the log takes any tag a runtime writes.
export type CloudLogEvent = CloudEvent | TurnEvent;

type CloudFailureTag =
  | "CloudInputUnsupported"
  | "CloudSendRejected"
  | "CloudSendUnknown"
  | "CloudCopyFailed";

// Only steps, counts, durations and error tags are logged, never a session id or text.
type CloudEvent =
  | {
      event: "claude_cloud";
      step:
        | "linked"
        | "link_refused"
        | "send_rejected"
        | "send_unknown"
        | "own_turn"
        | "wait_limit"
        | "stopped"
        | "compacted"
        | "copy_ran_model"
        | "copy_unchecked"
        | "review_shown"
        | "review_missing";
    }
  | { event: "claude_cloud"; step: "sent"; ms: number }
  | { event: "claude_cloud"; step: "child" | "review"; outcome: string }
  | { event: "claude_cloud"; step: "copied"; records: number; ms: number }
  | { event: "claude_cloud"; step: "copy_failed"; error: string }
  | { event: "claude_cloud"; step: "thread_not_renamed"; error: string };

// The thread has halted after an earlier copy that may have run a model turn, so no further copy is made.
class CloudCopyStopped extends TaggedError("CloudCopyStopped")<{
  message: string;
}> {}

class CloudCopyUnreadable extends TaggedError("CloudCopyUnreadable")<{
  cause: { _tag: string };
  message: string;
}> {}

type CopyFailure = CloudCopyFailure | CloudCopyStopped | CloudCopyUnreadable;

// What stops further copies of the chat after a failed copy, if anything.
const stoppedBy = (error: CopyFailure) =>
  matchError(error, {
    CloudCopyFailed: ({ stopped }) => stopped,
    CloudCopyStopped: () => "ran_model" as const,
    CloudOff: () => null,
    CloudCopyUnreadable: () => null,
  });

export type CloudDeps = {
  threads: Pick<
    ThreadValues,
    | "cloudOf"
    | "cloudOwner"
    | "cloudThreadIds"
    | "linkCloud"
    | "unlinkCloud"
    | "setCloudCopy"
    | "sessionIdOf"
    | "consumePick"
  >;
  sendToCloud: (
    cloudSessionId: string,
    text: string,
    cwd: string,
  ) => Promise<Result<void, CloudSendFailure>>;
  copy: (cloudSessionId: string) => Promise<Result<string, CloudCopyFailure>>;
  readCopy: (
    copySessionId: string,
  ) => Promise<Result<SessionMessage[], { _tag: string }>>;
  discardCopy: (copySessionId: string) => Promise<void>;
  // The whole conversation of a copy as finished turns, as a picked conversation is shown.
  replayHistory: (
    threadId: string,
    copySessionId: string,
    cwd: string,
  ) => Promise<readonly object[]>;
  send: (message: object) => void;
  log: (event: CloudEvent) => void;
  // Opens a chat in the app linked to a session a linked Cloud session started.
  // Answers how the app took it, such as done, for the log.
  openChild?: (parentThreadId: string, child: CloudChild) => Promise<string>;
  // Shows a review a linked Cloud session read in the reviewer's chat, opening it the first time; answers how the app took it, for the log.
  openReview?: (parentThreadId: string, review: CloudReview) => Promise<string>;
  // The review a /cloud-review message names, kept by openReview.
  reviewOf?: (key: string) => Promise<CloudReview | null>;
  renameThread?: (
    threadId: string,
    name: string,
  ) => Promise<Result<unknown, { _tag: string }>>;
  now?: () => number;
  // Waits the time, or less once woken; a turn being stopped wakes its wait.
  sleep?: (ms: number, woken: Promise<void>) => Promise<void>;
  schedule?: (run: () => Promise<void>, ms: number) => () => void;
  waitLimitMs?: number;
};

type Copied = { copy: string; records: SessionMessage[] };

// A copy holds the session as it was when the copy started, since records written later are left out, so of two copies the one started later is never older.
// overlapped: started while another copy ran, so it is checked against what was shown before it is used.
type Started = {
  at: number;
  overlapped: boolean;
  copied: Promise<Result<Copied, CopyFailure>>;
};

// What the runtime holds of a thread while it is in use; a thread with none of it set has no entry.
type CloudThread = {
  busy: boolean;
  follow: Follow | null;
  pendingOwn: Copied | null;
  // A thread whose copy may have run a model turn is not copied again until the bridge restarts, so the cost is not repeated.
  halted: boolean;
};

// What a turn the app started waits for: every text it sent, in order, then a reply that ends Claude's turn.
type Follow = {
  texts: string[];
  matched: number;
  // Messages sent while the turn runs whose send has not answered yet.
  sending: number;
  // The turn's first prompt, once a copy holds it, and the last record shown in the turn.
  record: string | null;
  last: string | null;
  // How far the app was shown when the turn was sent, so the prompt is looked for only after it.
  after: string | null;
  stop: boolean;
  wake: () => void;
  woken: Promise<void>;
};

export const createCloudRuntime = <Tag extends string>(
  inner: TurnRuntime<Tag>,
  {
    threads,
    sendToCloud,
    copy,
    readCopy,
    discardCopy,
    replayHistory,
    send,
    log,
    openChild,
    openReview,
    reviewOf,
    renameThread,
    now = Date.now,
    sleep = defaultSleep,
    schedule = defaultSchedule,
    waitLimitMs = WAIT_LIMIT_MS,
  }: CloudDeps,
): TurnRuntime<Tag | CloudFailureTag> => {
  type Turn = RunningTurn<Tag | CloudFailureTag>;

  const states = new Map<string, CloudThread>();
  const turnRecords = createTurnRecords();
  const openedChildren = new Set<string>();
  const openedReviews = new Set<string>();
  const unsentReviews = new Map<
    string,
    { threadId: string; review: CloudReview }
  >();
  const unsentChildren = new Map<
    string,
    { threadId: string; child: CloudChild }
  >();
  // One idle copy runs at a time per thread; a turn's copies skip the queue, and an idle copy made while a turn ran is dropped.
  const copies = createSerialQueue();
  let startOwnTurn = (_threadId: string) => false;
  let cancelTick: (() => void) | null = null;
  let ticking = false;
  // When each linked thread's next idle copy is due: soon while its session is in the middle of a recent turn, or was just linked, and after the idle wait otherwise.
  const dueAt = new Map<string, number>();
  let soon = false;
  let closed = false;

  const stateOf = (threadId: string): CloudThread =>
    states.get(threadId) ?? {
      busy: false,
      follow: null,
      pendingOwn: null,
      halted: false,
    };

  const keep = (threadId: string, change: Partial<CloudThread>) => {
    const next = { ...stateOf(threadId), ...change };
    if (next.busy || next.halted || next.follow || next.pendingOwn) {
      states.set(threadId, next);
    } else {
      states.delete(threadId);
    }
  };

  const run = async (turn: Turn) => {
    const reviewKey =
      turn.input.startedBy === "app"
        ? reviewCommandOf(reviewCommandText(turn.input))
        : null;
    if (reviewKey !== null) {
      await showReview(turn, reviewKey);
      return;
    }
    const command =
      turn.input.startedBy === "app"
        ? cloudCommandOf(commandText(turn.input))
        : null;
    if (command !== null) {
      await link(turn, command, sessionCommandTextOf(turn.input) !== null);
      return;
    }
    const cloud = threads.cloudOf(turn.threadId);
    if (cloud === null) {
      await inner.run(turn as RunningTurn<Tag>);
      return;
    }
    if (turn.input.startedBy === "claude") {
      await showOwn(turn, cloud);
      return;
    }
    await sendAndFollow(turn, cloud);
  };

  const reply = (turn: Turn, text: string) => {
    turn.apply(renderNotice(turn.state(), text, "final_answer", now()));
    turn.finish(
      turn.state().interrupting
        ? { status: "interrupted" }
        : { status: "completed" },
      null,
    );
  };

  // Links the thread to a Cloud session, answered by the bridge like /resume.
  const link = async (turn: Turn, argument: string, typed: boolean) => {
    const { threadId } = turn;
    const refuse = (text: string) => {
      log({ event: "claude_cloud", step: "link_refused" });
      reply(turn, text);
    };
    const cloudSessionId = parseCloudSessionId(argument);
    if (cloudSessionId === null) {
      refuse(LINK_USAGE);
      return;
    }
    if (
      threads.sessionIdOf(threadId) !== null ||
      threads.cloudOf(threadId) !== null
    ) {
      refuse(LINK_HAS_CONVERSATION);
      return;
    }
    if (threads.cloudOwner(cloudSessionId) !== undefined) {
      refuse(LINK_TAKEN);
      return;
    }
    const copied = await copyOf(threadId, cloudSessionId);
    if (copied.isErr()) {
      refuse(`${LINK_NOT_COPIED}: ${copied.error.message}`);
      return;
    }
    const shown = keyOfLast(copied.value.records);
    const linked = await threads.linkCloud(
      threadId,
      { sessionId: cloudSessionId, shown },
      copied.value.copy,
    );
    if (linked.isErr()) {
      await discardCopy(copied.value.copy);
      refuse(
        linked.error._tag === "CloudSessionTaken"
          ? LINK_TAKEN
          : linked.error._tag === "ThreadHasConversation"
            ? LINK_HAS_CONVERSATION
            : LINK_NOT_SAVED,
      );
      return;
    }
    log({ event: "claude_cloud", step: "linked" });
    reply(turn, LINKED);
    // A session still running its turn, such as one just started, is copied again soon rather than after the idle wait.
    const last = copied.value.records.at(-1);
    if (last === undefined || !replied(last)) hurry(threadId);
    // A chat another chat opened has the name it was given; a failed rename leaves the name as it was.
    if (typed && renameThread !== undefined)
      void renameThread(
        threadId,
        cloudChatName(copied.value.records, cloudSessionId),
      ).then((renamed) => {
        if (renamed.isErr())
          log({
            event: "claude_cloud",
            step: "thread_not_renamed",
            error: renamed.error._tag,
          });
      });
    // Sent after the command's own turn ends, so the earlier turns follow it rather than interleave with it.
    const replayed = await replayHistory(
      threadId,
      copied.value.copy,
      turn.record.worktree,
    );
    if (replayed.length === 0) return;
    for (const notification of replayed) send(notification);
    threads.consumePick(threadId);
  };

  // Shows a review in the reviewer's chat, answered by the bridge like /cloud.
  const showReview = async (turn: Turn, key: string) => {
    const review = reviewOf === undefined ? null : await reviewOf(key);
    log({
      event: "claude_cloud",
      step: review === null ? "review_missing" : "review_shown",
    });
    reply(turn, review === null ? REVIEW_MISSING : reviewText(review));
  };

  const sendAndFollow = async (turn: Turn, cloud: CloudLink) => {
    const { threadId } = turn;
    if (turn.compaction) {
      turn.fail({
        _tag: "CloudInputUnsupported",
        message: refusalMessage("cloud_unsupported"),
      });
      return;
    }
    if (turn.input.images.length > 0) {
      turn.fail({
        _tag: "CloudInputUnsupported",
        message: refusalMessage("cloud_images"),
      });
      return;
    }
    if (turn.state().interrupting) {
      turn.finish({ status: "interrupted" }, null);
      return;
    }
    const sent = await sendMessage(turn, cloud, turn.input.text);
    if (sent.isErr()) {
      turn.fail(
        matchError(sent.error, {
          CloudSendRejected: ({ _tag, message }) => ({
            _tag,
            message: `${refusalMessage("cloud_not_sent")} (${message})`,
          }),
          CloudSendUnknown: ({ _tag, message }) => ({
            _tag,
            message: `${refusalMessage("cloud_send_unknown")} (${message})`,
          }),
        }),
      );
      return;
    }
    const follow = newFollow(turn.input.text, cloud.shown);
    keep(threadId, { follow });
    try {
      await waitForReply(turn, follow, cloud.sessionId);
    } finally {
      if (stateOf(threadId).follow === follow) keep(threadId, { follow: null });
    }
  };

  // Sends a turn's first message or a steer to the Cloud session and logs how it went.
  const sendMessage = async (turn: Turn, cloud: CloudLink, text: string) => {
    const startedAt = now();
    const sent = await sendToCloud(cloud.sessionId, text, turn.record.worktree);
    if (sent.isOk()) {
      log({ event: "claude_cloud", step: "sent", ms: now() - startedAt });
    } else if (sent.error._tag === "CloudSendRejected") {
      log({ event: "claude_cloud", step: "send_rejected" });
    } else {
      log({ event: "claude_cloud", step: "send_unknown" });
      turn.markOutcomeUnknown();
    }
    return sent;
  };

  const waitForReply = async (
    turn: Turn,
    follow: Follow,
    cloudSessionId: string,
  ) => {
    const { threadId } = turn;
    const startedAt = now();
    let failingSince: number | null = null;
    // While a reply is young, a copy starts every OVERLAP_MS without waiting for the ones running, and each is read as soon as it ends.
    const running: Started[] = [];
    // When the copy last shown started; a copy started before it is older and dropped.
    let shownAt = Number.NEGATIVE_INFINITY;
    // When the latest copy started, so copies keep OVERLAP_MS apart even when one ends sooner.
    let lastAt = Number.NEGATIVE_INFINITY;
    // Copies overlap only once one has worked, so a copy that runs a model turn is caught before a second one starts.
    let copiedOnce = false;
    const overlapping = () =>
      copiedOnce &&
      failingSince === null &&
      now() - startedAt < BACK_TO_BACK_FOR_MS &&
      running.length < OVERLAP_LIMIT;
    // The first copy to end, or null once it is time to start another or the turn is being stopped.
    const nextEnded = () => {
      const due =
        running.length > 0 && overlapping()
          ? sleep(Math.max(0, lastAt + OVERLAP_MS - now()), follow.woken)
          : follow.woken;
      return Promise.race([
        ...running.map((started) =>
          started.copied.then((copied) => ({ started, copied })),
        ),
        due.then(() => null),
      ]);
    };
    // Copies still running are removed once written, however the wait ends.
    try {
      for (;;) {
        if (running.length === 0) {
          await sleep(
            Math.max(
              pollMs(now() - startedAt, failingSince !== null),
              lastAt + OVERLAP_MS - now(),
            ),
            follow.woken,
          );
        }
        if (follow.stop || closed || turn.state().interrupting) {
          log({ event: "claude_cloud", step: "stopped" });
          turn.apply(
            renderNotice(turn.state(), STOPPED_WAITING, "commentary", now()),
          );
          turn.finish({ status: "interrupted" }, null);
          return;
        }
        if (
          running.length === 0 ||
          (overlapping() && now() - lastAt >= OVERLAP_MS)
        ) {
          const overlapped = running.length > 0;
          lastAt = now();
          running.push({
            at: lastAt,
            overlapped,
            copied: fetchCopy(threadId, cloudSessionId),
          });
        }
        const ended = await nextEnded();
        if (ended === null) continue;
        running.splice(running.indexOf(ended.started), 1);
        const { copied } = ended;
        // The session only grows between compactions, so an overlapping copy without the last record shown read it before that record arrived; a compaction is taken by the next copy that does not overlap.
        const shownLast = follow.last ?? follow.after;
        if (
          ended.started.at < shownAt ||
          (ended.started.overlapped &&
            copied.isOk() &&
            shownLast !== null &&
            indexOf(copied.value.records, shownLast) === -1)
        ) {
          if (copied.isOk()) await discardCopy(copied.value.copy);
          continue;
        }
        if (copied.isErr()) {
          failingSince ??= now();
          if (
            stoppedBy(copied.error) === null &&
            now() - failingSince < COPY_FAILING_LIMIT_MS
          ) {
            continue;
          }
          turn.fail({
            _tag: "CloudCopyFailed",
            message: `${COPY_FAILED}: ${copied.error.message}`,
          });
          return;
        }
        failingSince = null;
        copiedOnce = true;
        shownAt = ended.started.at;
        const progress = advance(follow, copied.value.records);
        if (progress.shown.length > 0) {
          turn.apply(renderRecords(turn.state(), progress.shown, now()));
        }
        // The history the app reads is built from the latest copy, so the turn names its prompt by that copy's uuid.
        const prompt =
          copied.value.records[indexOf(copied.value.records, follow.record)];
        if (prompt !== undefined) {
          turnRecords.note(threadId, turn.turnId, prompt.uuid);
        }
        await keepCopy(
          threadId,
          copied.value.copy,
          follow.last ?? threads.cloudOf(threadId)?.shown ?? null,
        );
        // Checked after the save, so a message sent meanwhile is waited for too.
        if (
          progress.ended &&
          follow.sending === 0 &&
          follow.matched === follow.texts.length
        ) {
          turn.finish({ status: "completed" }, null);
          return;
        }
        if (now() - startedAt >= waitLimitMs) {
          log({ event: "claude_cloud", step: "wait_limit" });
          turn.apply(
            renderNotice(turn.state(), WAIT_LIMIT_REACHED, "commentary", now()),
          );
          turn.finish({ status: "completed" }, null);
          return;
        }
      }
    } finally {
      for (const started of running) void discardStarted(started);
    }
  };

  // The records of a copy past what the turn showed, and whether its reply ended.
  const advance = (follow: Follow, all: readonly SessionMessage[]) => {
    const from = indexAfter(all, follow.after);
    const shown: SessionMessage[] = [];
    if (follow.record === null) {
      const first = follow.texts[0] ?? "";
      let found = -1;
      for (let index = all.length - 1; index >= from; index--) {
        const message = all[index];
        if (message !== undefined && samePrompt(message, first)) {
          found = index;
          break;
        }
      }
      if (found === -1) return { shown: [], ended: false };
      // What the session did before the message that the app was not shown, such as a reply still running when the chat was linked.
      shown.push(...all.slice(from, found));
      follow.record = keyOf(all[found]);
      follow.matched = 1;
      follow.last = follow.record;
    }
    const start = indexAfter(all, follow.last);
    let lastPrompt = indexOf(all, follow.record);
    for (let index = start; index < all.length; index++) {
      const message = all[index];
      if (message === undefined) continue;
      const next = follow.texts[follow.matched];
      // A prompt this turn sent is shown by the app already, so only replies and prompts typed elsewhere are rendered.
      if (next !== undefined && samePrompt(message, next)) {
        follow.matched += 1;
        lastPrompt = index;
      } else {
        shown.push(message);
      }
      follow.last = message.uuid;
    }
    const last = all.at(-1);
    const ended =
      last !== undefined && replied(last) && all.length - 1 > lastPrompt;
    return { shown, ended };
  };

  const showOwn = async (turn: Turn, cloud: CloudLink) => {
    const { threadId } = turn;
    const { pendingOwn: taken } = stateOf(threadId);
    keep(threadId, { pendingOwn: null });
    const copied =
      taken === null
        ? await copyOf(threadId, cloud.sessionId)
        : Result.ok<Copied, CopyFailure>(taken);
    if (copied.isErr()) {
      turn.finish({ status: "completed" }, null);
      return;
    }
    const all = copied.value.records;
    const shown = all.slice(indexAfter(all, cloud.shown));
    log({ event: "claude_cloud", step: "own_turn" });
    if (shown.length > 0) {
      turn.apply(renderRecords(turn.state(), shown, now()));
      const first = shown[0];
      if (first !== undefined) {
        turnRecords.note(threadId, turn.turnId, first.uuid);
      }
    }
    await keepCopy(threadId, copied.value.copy, keyOfLast(all) ?? cloud.shown);
    turn.finish({ status: "completed" }, null);
  };

  const copyOf = (threadId: string, cloudSessionId: string) =>
    copies.run(threadId, () => fetchCopy(threadId, cloudSessionId));

  const fetchCopy = async (
    threadId: string,
    cloudSessionId: string,
  ): Promise<Result<Copied, CopyFailure>> => {
    if (stateOf(threadId).halted) {
      return Result.err(new CloudCopyStopped({ message: COPY_STOPPED }));
    }
    const startedAt = now();
    const copied = await copy(cloudSessionId);
    if (copied.isErr()) {
      const stopped = stoppedBy(copied.error);
      if (stopped !== null) keep(threadId, { halted: true });
      log(
        stopped === null
          ? {
              event: "claude_cloud",
              step: "copy_failed",
              error: copied.error._tag,
            }
          : {
              event: "claude_cloud",
              step:
                stopped === "ran_model" ? "copy_ran_model" : "copy_unchecked",
            },
      );
      return Result.err(copied.error);
    }
    const read = await readCopy(copied.value);
    if (read.isErr()) {
      await discardCopy(copied.value);
      log({
        event: "claude_cloud",
        step: "copy_failed",
        error: read.error._tag,
      });
      return Result.err(
        new CloudCopyUnreadable({
          cause: read.error,
          message: COPY_UNREADABLE,
        }),
      );
    }
    const all = mainRecords(read.value);
    log({
      event: "claude_cloud",
      step: "copied",
      records: all.length,
      ms: now() - startedAt,
    });
    noticeChildren(threadId, all);
    noticeReviews(threadId, all);
    return Result.ok({ copy: copied.value, records: all });
  };

  // Shows each review a linked session read after the app was last shown, once, in its reviewer's chat.
  const noticeReviews = (threadId: string, all: readonly SessionMessage[]) => {
    const cloud = threads.cloudOf(threadId);
    if (openReview === undefined || cloud === null) return;
    const after = indexAfter(all, cloud.shown);
    const unsent = [...unsentReviews.values()]
      .filter((entry) => entry.threadId === threadId)
      .map((entry) => entry.review);
    for (const review of [...unsent, ...reviewsIn(all, after)]) {
      if (openedReviews.has(review.key)) continue;
      openedReviews.add(review.key);
      void openReview(threadId, review)
        .catch(() => "threw")
        .then((outcome) => {
          if (UNSENT_OUTCOMES.has(outcome)) {
            openedReviews.delete(review.key);
            unsentReviews.set(review.key, { threadId, review });
          } else {
            unsentReviews.delete(review.key);
          }
          log({ event: "claude_cloud", step: "review", outcome });
        });
    }
  };

  // Opens a chat, once, for each session a linked one started after the app was last shown.
  const noticeChildren = (threadId: string, all: readonly SessionMessage[]) => {
    // A copy made while a chat is being linked, or one whose link failed, opens nothing.
    const cloud = threads.cloudOf(threadId);
    if (openChild === undefined || cloud === null) return;
    // A session started before the app was last shown was the user's to link.
    const after = indexAfter(all, cloud.shown);
    const unsent = [...unsentChildren.values()]
      .filter((entry) => entry.threadId === threadId)
      .map((entry) => entry.child);
    for (const child of [...unsent, ...childSessionsIn(all, after)]) {
      if (openedChildren.has(child.sessionId)) continue;
      // A session already linked has its chat.
      if (threads.cloudOwner(child.sessionId) !== undefined) {
        unsentChildren.delete(child.sessionId);
        continue;
      }
      openedChildren.add(child.sessionId);
      void openChild(threadId, child)
        .catch(() => "threw")
        .then((outcome) => {
          // Only a chat known not to be created is tried again, from here and not from the shown position, which a turn moves past it; any other answer may have made the chat.
          if (UNSENT_OUTCOMES.has(outcome)) {
            openedChildren.delete(child.sessionId);
            unsentChildren.set(child.sessionId, { threadId, child });
          } else {
            unsentChildren.delete(child.sessionId);
          }
          log({ event: "claude_cloud", step: "child", outcome });
        });
    }
  };

  const discardStarted = async (started: Started) => {
    const copied = await started.copied;
    if (copied.isOk()) await discardCopy(copied.value.copy);
  };

  const keepCopy = async (
    threadId: string,
    copySessionId: string,
    shown: string | null,
  ) => {
    const previous = threads.sessionIdOf(threadId);
    const saved = await threads.setCloudCopy(threadId, copySessionId, shown);
    // Until the new copy is saved, the saved state still names the previous one, which a restart reads.
    if (saved.isOk() && previous !== null && previous !== copySessionId) {
      await discardCopy(previous);
    }
  };

  // Copies each linked thread with no turn running whose idle copy is due, and opens a turn of Claude's own for what it shows past where the app was shown.
  const tick = async () => {
    const linked = threads.cloudThreadIds();
    for (const threadId of dueAt.keys()) {
      if (!linked.includes(threadId)) dueAt.delete(threadId);
    }
    for (const threadId of linked) {
      if (closed) return;
      if ((dueAt.get(threadId) ?? 0) > now()) continue;
      const copied = await copyIdle(threadId);
      if (copied === "skipped") continue;
      dueAt.set(threadId, now() + (copied === "working" ? POLL_MS : IDLE_MS));
    }
  };

  // Whether the session was in the middle of a recent turn, or skipped when the thread is busy or no longer linked.
  const copyIdle = async (
    threadId: string,
  ): Promise<"working" | "idle" | "skipped"> => {
    const { busy, halted } = stateOf(threadId);
    if (busy || halted) return "skipped";
    const cloud = threads.cloudOf(threadId);
    if (cloud === null) return "skipped";
    const reading = threads.sessionIdOf(threadId);
    const copied = await copyOf(threadId, cloud.sessionId);
    if (copied.isErr()) return "idle";
    // A turn that ran while this copy was made saved a newer one, which this copy may be older than.
    if (stateOf(threadId).busy || threads.sessionIdOf(threadId) !== reading) {
      await discardCopy(copied.value.copy);
      return "skipped";
    }
    const all = copied.value.records;
    const last = all.at(-1);
    const recordAt = last === undefined ? null : timeOf(last);
    const working =
      last !== undefined &&
      !replied(last) &&
      recordAt !== null &&
      now() - recordAt < WORKING_FOR_MS;
    const at = indexOf(all, cloud.shown);
    // Claude compacted the session past the record the app was shown, so everything the copy holds came after it and is shown.
    if (cloud.shown !== null && at === -1) {
      log({ event: "claude_cloud", step: "compacted" });
    }
    if (at === all.length - 1 || all.length === 0) {
      await discardCopy(copied.value.copy);
    } else {
      keep(threadId, { pendingOwn: copied.value });
      if (!startOwnTurn(threadId)) {
        keep(threadId, { pendingOwn: null });
        await keepCopy(threadId, copied.value.copy, cloud.shown);
      }
    }
    return working ? "working" : "idle";
  };

  // The wait until the earliest idle copy is due, kept between POLL_MS and IDLE_MS.
  const nextWait = () => {
    if (soon) return POLL_MS;
    let wait = IDLE_MS;
    for (const threadId of threads.cloudThreadIds()) {
      wait = Math.min(wait, (dueAt.get(threadId) ?? 0) - now());
    }
    return Math.max(POLL_MS, wait);
  };

  const plan = (ms: number) => {
    if (closed) return;
    cancelTick = schedule(async () => {
      ticking = true;
      await tick();
      ticking = false;
      const next = nextWait();
      soon = false;
      plan(next);
    }, ms);
  };

  // Brings a thread's idle copy forward; a copy already running plans the next one itself.
  const hurry = (threadId: string) => {
    dueAt.set(threadId, 0);
    soon = true;
    if (ticking || closed) return;
    cancelTick?.();
    plan(POLL_MS);
  };

  const stopFollowing = (threadId: string) => {
    const { follow } = stateOf(threadId);
    if (follow === null) return false;
    follow.stop = true;
    follow.wake();
    return true;
  };

  const steer = async (
    turn: Turn,
    input: Parameters<TurnRuntime<Tag>["steer"]>[1],
  ): Promise<Refusal | null> => {
    const cloud = threads.cloudOf(turn.threadId);
    if (cloud === null) return inner.steer(turn as RunningTurn<Tag>, input);
    const { follow } = stateOf(turn.threadId);
    if (follow === null || follow.stop) return "steer_not_sent";
    if (input.images.length > 0) return "cloud_images";
    // Counted before it is sent, so a reply that arrives meanwhile does not end the turn before this message is answered.
    follow.texts.push(input.text);
    follow.sending += 1;
    const sent = await sendMessage(turn, cloud, input.text);
    follow.sending -= 1;
    if (sent.isErr()) forget(follow, input.text);
    if (sent.isErr() && sent.error._tag === "CloudSendRejected") {
      return "cloud_not_sent";
    }
    // The message may have reached the session, so it is taken rather than refused, which would run it again as a turn; the thread is left with an unknown outcome to check before going on.
    if (sent.isErr()) {
      turn.apply(
        renderNotice(
          turn.state(),
          refusalMessage("cloud_send_unknown"),
          "commentary",
          now(),
        ),
      );
    }
    return null;
  };

  return {
    compactPrompt: inner.compactPrompt,
    closeSession: (threadId) => inner.closeSession(threadId),
    pauseMessages: (threadId) => inner.pauseMessages(threadId),
    recordOf: (threadId, turnId) =>
      turnRecords.recordOf(threadId, turnId) ??
      inner.recordOf(threadId, turnId),
    run,
    steer,
    interrupt: (turn, repeated) => {
      if (threads.cloudOf(turn.threadId) !== null) {
        // Stopping only ends the wait; the Cloud session keeps working, which only claude.ai can stop.
        stopFollowing(turn.threadId);
        return;
      }
      inner.interrupt(turn as RunningTurn<Tag>, repeated);
    },
    dropSession: (threadId, link) => inner.dropSession(threadId, link),
    noteFork: (threadId) => inner.noteFork(threadId),
    dropFork: (threadId) => inner.dropFork(threadId),
    forgetThread: (threadId, ended) => {
      const { busy, follow, pendingOwn } = stateOf(threadId);
      if (busy || follow !== null || pendingOwn !== null) return;
      // The copies of a linked thread go on while the store holds it, so only the turn records go and halted stays.
      turnRecords.forget(threadId);
      // A child chat not yet opened is dropped only with a deleted parent.
      if (ended === "deleted") {
        for (const [sessionId, entry] of unsentChildren) {
          if (entry.threadId === threadId) unsentChildren.delete(sessionId);
        }
        for (const [key, entry] of unsentReviews) {
          if (entry.threadId === threadId) unsentReviews.delete(key);
        }
        // A deleted thread cannot return, so its session is no longer copied and is free for another thread; an archived one keeps it.
        if (threads.cloudOf(threadId) !== null) {
          const copy = threads.sessionIdOf(threadId);
          states.delete(threadId);
          void threads.unlinkCloud(threadId).then(async (unlinked) => {
            if (unlinked.isOk() && copy !== null) await discardCopy(copy);
          });
        }
      }
      inner.forgetThread(threadId, ended);
    },
    threadBusy: (threadId) => {
      keep(threadId, { busy: true });
      inner.threadBusy(threadId);
    },
    threadIdle: (threadId) => {
      keep(threadId, { busy: false });
      inner.threadIdle(threadId);
    },
    listen: (start) => {
      startOwnTurn = start;
      inner.listen(start);
      plan(FIRST_TICK_MS);
    },
    closeAll: () => {
      closed = true;
      cancelTick?.();
      for (const threadId of states.keys()) stopFollowing(threadId);
      inner.closeAll();
    },
  };
};

const newFollow = (text: string, after: string | null): Follow => {
  let wake = () => {};
  const woken = new Promise<void>((resolve) => {
    wake = resolve;
  });
  return {
    texts: [text],
    matched: 0,
    sending: 0,
    record: null,
    last: null,
    after,
    stop: false,
    wake,
    woken,
  };
};

const pollMs = (waited: number, failing: boolean) => {
  // A failing copy may end at once, so it is not tried again without a wait.
  if (failing) return FAST_POLL_MS;
  // A short reply comes within the first seconds, so copies overlap then (see waitForReply); after that they come less often, since every copy starts claude and rewrites the whole session.
  if (waited < BACK_TO_BACK_FOR_MS) return 0;
  return waited < FAST_POLL_FOR_MS ? FAST_POLL_MS : POLL_MS;
};

// The text of a message that may be a session command.
const commandText = (input: TurnInput) => {
  const typed = sessionCommandTextOf(input);
  if (typed !== null || input.toolOutput?.name !== "create_thread")
    return typed;
  // The first message of a chat another chat opened with create_thread, as harnexus-task cloud does, can link it too.
  return delegatedTextOf(input);
};

// A /cloud-review comes from the bridge through the reviewer's chat's parent, as its first message or a later one, or is typed.
const reviewCommandText = (input: TurnInput) =>
  sessionCommandTextOf(input) ??
  (input.toolOutput?.name === "create_thread" ||
  input.toolOutput?.name === "send_message_to_thread"
    ? delegatedTextOf(input)
    : null);

// What another chat sent, which arrives wrapped in its delegation as its <input>, which older apps named <prompt>.
const delegatedTextOf = (input: TurnInput) => {
  const output = input.toolOutput;
  if (output === null) return null;
  const delegation =
    typeof output.output === "string"
      ? output.output
      : output.output.map((item) => item.text).join("\n");
  const prompt = DELEGATED_PROMPT.exec(delegation)?.[2];
  return prompt === undefined ? null : unescapeXml(prompt);
};

const DELEGATED_PROMPT = /<(input|prompt)>([\s\S]*?)<\/\1>/;

const unescapeXml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

const cloudCommandOf = (text: string | null) => {
  const matched = text === null ? null : CLOUD_COMMAND.exec(text.trim());
  return matched === null ? null : (matched[1] ?? "");
};

const CLOUD_COMMAND = /^\/cloud(?:\s+(\S+))?\s*$/;

const reviewCommandOf = (text: string | null) =>
  text === null ? null : (REVIEW_COMMAND.exec(text.trim())?.[1] ?? null);

const REVIEW_COMMAND = /^\/cloud-review\s+([A-Za-z0-9_-]{1,128})$/;

export const reviewText = (review: CloudReview) =>
  `${review.answer.trim()}\n\n${REVIEW_FOOTER(review)}`;

const REVIEW_FOOTER = (review: CloudReview) =>
  `_Codex reviewer \`${review.reviewer}\`${review.head === null ? "" : ` on \`${review.head.slice(0, 7)}\``}, run in a Cloud session. Ask for changes in the worker's chat._`;

const REVIEW_MISSING =
  "This review is no longer kept on this Mac, so it cannot be shown here.";

// The mark that tells a chat showing a Cloud session from other chats in the app's list.
export const CLOUD_MARK = "☁️";

// The session's first prompt on one line, after the mark, the way a chat is named after its first message.
const cloudChatName = (
  records: readonly SessionMessage[],
  sessionId: string,
) => {
  const first = records
    .map((record) => turnOpeningTextOf(record)?.replace(/\s+/g, " ").trim())
    .find((text) => text !== undefined && text !== "");
  // Cut by what reads as one character, so an emoji is never split.
  const characters =
    first === undefined
      ? []
      : [...GRAPHEMES.segment(first)].map((part) => part.segment);
  const name =
    first === undefined
      ? sessionId
      : characters.length > NAME_LENGTH
        ? `${characters.slice(0, NAME_LENGTH - 1).join("")}…`
        : first;
  return `${CLOUD_MARK} ${name}`;
};

const NAME_LENGTH = 60;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// A record that ends Claude's turn with something to read; a copy may mark the thinking that opens the reply as the end too, before the reply's text arrives.
const replied = (message: SessionMessage) =>
  endsTurn(message) &&
  isObject(message.message) &&
  Array.isArray(message.message.content) &&
  message.message.content.some(
    (block) =>
      isObject(block) &&
      block.type !== "thinking" &&
      block.type !== "redacted_thinking",
  );

const UNSENT_OUTCOMES = new Set(["not_sent", "no_project", "no_parent"]);

// Stops waiting for a message whose send failed.
const forget = (follow: Follow, text: string) => {
  // One not yet matched is taken from the end, so the order of the others stays.
  const at = follow.texts.lastIndexOf(text);
  if (at >= follow.matched) follow.texts.splice(at, 1);
};

const samePrompt = (message: SessionMessage, text: string) =>
  turnOpeningTextOf(message)?.trim() === text.trim();

const keyOf = (message: SessionMessage | undefined) => message?.uuid ?? null;

const keyOfLast = (all: readonly SessionMessage[]) => keyOf(all.at(-1));

const indexOf = (all: readonly SessionMessage[], key: string | null) =>
  key === null ? -1 : all.findIndex((message) => message.uuid === key);

const indexAfter = (all: readonly SessionMessage[], uuid: string | null) => {
  const at = indexOf(all, uuid);
  // A record no longer in the copy, such as one Claude compacted away, leaves nothing to skip.
  return at === -1 ? 0 : at + 1;
};

const defaultSleep = (ms: number, woken: Promise<void>) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void woken.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });

const defaultSchedule = (run: () => Promise<void>, ms: number) => {
  const timer = setTimeout(() => void run(), ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export const serializeCloudEvent = (entry: CloudEvent) => {
  switch (entry.step) {
    case "sent":
      return { event: entry.event, step: entry.step, ms: entry.ms };
    case "child":
    case "review":
      return { event: entry.event, step: entry.step, outcome: entry.outcome };
    case "copied":
      return {
        event: entry.event,
        step: entry.step,
        records: entry.records,
        ms: entry.ms,
      };
    case "copy_failed":
    case "thread_not_renamed":
      return { event: entry.event, step: entry.step, error: entry.error };
    default:
      return { event: entry.event, step: entry.step };
  }
};

const LINK_USAGE =
  "Send /cloud followed by a Cloud session id or its claude.ai/code URL, such as /cloud session_01AbC…, to show that session in this thread.";

const LINK_HAS_CONVERSATION =
  "This thread already holds a conversation; open a new Claude thread and send /cloud there.";

const LINK_TAKEN =
  "That Cloud session is already shown in another thread; continue it there.";

const LINK_NOT_COPIED = "The Cloud session could not be copied";

const LINK_NOT_SAVED =
  "The link to the Cloud session could not be saved; send /cloud again.";

const LINKED =
  "This thread now shows the Cloud session. Messages you send here go to it, and its replies appear here as they are copied. Stopping a turn here does not stop the session; stop it on claude.ai.";

const STOPPED_WAITING =
  "Stopped waiting here. The Cloud session keeps working; stop it on claude.ai if needed. Later replies appear here when they are copied.";

const WAIT_LIMIT_REACHED =
  "The Cloud session is still working. Its later replies appear here when they are copied.";

const COPY_FAILED =
  "The message reached the Cloud session, but its replies could not be copied; the session keeps working, so check it on claude.ai rather than sending again";

const COPY_STOPPED =
  "copies of this chat stopped because one may have run a model turn; restart harnexus after checking bun run doctor";

const COPY_UNREADABLE = "the copy of the Cloud session could not be read";

const BACK_TO_BACK_FOR_MS = 20_000;

const OVERLAP_MS = 1_500;

const OVERLAP_LIMIT = 3;

const FAST_POLL_MS = 3_000;

const FAST_POLL_FOR_MS = 60_000;

const POLL_MS = 10_000;

const IDLE_MS = 5 * 60_000;
// How recent the last record of a session still in its turn must be for the idle copies to come at POLL_MS.
const WORKING_FOR_MS = 10 * 60_000;

const FIRST_TICK_MS = 15_000;

const WAIT_LIMIT_MS = 60 * 60_000;

// Measured in time rather than tries, since the wait between copies changes.
const COPY_FAILING_LIMIT_MS = 20_000;
