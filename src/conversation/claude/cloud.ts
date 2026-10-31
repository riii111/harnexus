import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "better-result";
import {
  type CloudSend,
  parseCloudSessionId,
} from "../../infra/claude/cloud.ts";
import type { CloudLink } from "../../infra/thread-store.ts";
import {
  endsTurn,
  mainRecords,
  promptTextOf,
  renderRecords,
} from "../../presentation/history.ts";
import { renderNotice } from "../../presentation/turn.ts";
import { createSerialQueue } from "../../runtime/serial-queue.ts";
import type { TurnEvent } from "../controller.ts";
import { type Refusal, refusalMessage } from "../thread-request.ts";
import type { ThreadValues } from "../thread-values.ts";
import type { RunningTurn, TurnInput, TurnRuntime } from "../turn-runtime.ts";
import { type CloudChild, childSessionsIn } from "./cloud-children.ts";
import { typedText } from "./runtime.ts";

// A Cloud thread's turns log their failure tags beside the Claude runtime's, so the log takes any tag a runtime writes.
export type CloudLogEvent = CloudEvent | TurnEvent;

export type CloudFailureTag =
  | "CloudInputUnsupported"
  | "CloudSendRejected"
  | "CloudSendUnknown"
  | "CloudCopyFailed";

// Only steps, counts, durations and error tags are logged, never a session id or text.
export type CloudEvent =
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
        | "copy_unchecked";
    }
  | { event: "claude_cloud"; step: "sent"; ms: number }
  | { event: "claude_cloud"; step: "child"; outcome: string }
  | { event: "claude_cloud"; step: "copied"; records: number; ms: number }
  | { event: "claude_cloud"; step: "copy_failed"; error: string };

// stopped says the copy may have run a model turn, so the chat is not copied again.
type CopyFailure = {
  _tag: string;
  stopped: "ran_model" | "unchecked" | null;
  message: string;
};

export type CloudDeps = {
  threads: Pick<
    ThreadValues,
    | "cloudOf"
    | "cloudOwner"
    | "cloudThreadIds"
    | "linkCloud"
    | "setCloudCopy"
    | "sessionIdOf"
    | "takePicked"
  >;
  sendToCloud: (
    cloudSessionId: string,
    text: string,
    cwd: string,
  ) => Promise<CloudSend>;
  copy: (cloudSessionId: string) => Promise<Result<string, CopyFailure>>;
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
    now = Date.now,
    sleep = defaultSleep,
    schedule = defaultSchedule,
    waitLimitMs = WAIT_LIMIT_MS,
  }: CloudDeps,
): TurnRuntime<Tag | CloudFailureTag> => {
  type Turn = RunningTurn<Tag | CloudFailureTag>;

  const follows = new Map<string, Follow>();
  const records = new Map<string, Map<string, string>>();
  const busy = new Set<string>();
  // A thread whose copy may have run a model turn is not copied again until the bridge restarts, so the cost is not repeated.
  const halted = new Set<string>();
  const pendingOwn = new Map<string, Copied>();
  const openedChildren = new Set<string>();
  const unsentChildren = new Map<
    string,
    { threadId: string; child: CloudChild }
  >();
  const copies = createSerialQueue();
  let startOwnTurn = (_threadId: string) => false;
  let cancelTick: (() => void) | null = null;
  let closed = false;

  const run = async (turn: Turn) => {
    const command =
      turn.input.startedBy === "app"
        ? cloudCommandOf(commandText(turn.input))
        : null;
    if (command !== null) {
      await link(turn, command);
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

  // Answered by the bridge like /resume, and allowed only in a thread that has no conversation yet.
  const link = async (turn: Turn, argument: string) => {
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
    // Sent after the command's own turn ends, so the earlier turns follow it rather than interleave with it.
    const replayed = await replayHistory(
      threadId,
      copied.value.copy,
      turn.record.worktree,
    );
    if (replayed.length === 0) return;
    for (const notification of replayed) send(notification);
    threads.takePicked(threadId);
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
    const sendStartedAt = now();
    const sent = await sendToCloud(
      cloud.sessionId,
      turn.input.text,
      turn.record.worktree,
    );
    if (sent.kind === "rejected") {
      log({ event: "claude_cloud", step: "send_rejected" });
      turn.fail({
        _tag: "CloudSendRejected",
        message: `${refusalMessage("cloud_not_sent")} (${sent.message})`,
      });
      return;
    }
    if (sent.kind === "unknown") {
      log({ event: "claude_cloud", step: "send_unknown" });
      turn.markOutcomeUnknown();
      turn.fail({
        _tag: "CloudSendUnknown",
        message: `${refusalMessage("cloud_send_unknown")} (${sent.message})`,
      });
      return;
    }
    log({ event: "claude_cloud", step: "sent", ms: now() - sendStartedAt });
    const follow = newFollow(turn.input.text, cloud.shown);
    follows.set(threadId, follow);
    try {
      await waitForReply(turn, follow, cloud.sessionId);
    } finally {
      if (follows.get(threadId) === follow) follows.delete(threadId);
    }
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
            copied.error.stopped === null &&
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
        if (prompt !== undefined)
          noteRecord(threadId, turn.turnId, prompt.uuid);
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

  // Records already shown are skipped by the last one shown; a prompt this turn sent is shown by the app already, so only replies and prompts typed elsewhere are rendered.
  const advance = (follow: Follow, all: readonly SessionMessage[]) => {
    const from = indexAfter(all, follow.after);
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
      follow.record = keyOf(all[found]);
      follow.matched = 1;
      follow.last = follow.record;
    }
    const start = indexAfter(all, follow.last);
    const shown: SessionMessage[] = [];
    let lastPrompt = indexOf(all, follow.record);
    for (let index = start; index < all.length; index++) {
      const message = all[index];
      if (message === undefined) continue;
      const next = follow.texts[follow.matched];
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
      last !== undefined && endsTurn(last) && all.length - 1 > lastPrompt;
    return { shown, ended };
  };

  const showOwn = async (turn: Turn, cloud: CloudLink) => {
    const { threadId } = turn;
    const taken = pendingOwn.get(threadId);
    pendingOwn.delete(threadId);
    const copied =
      taken === undefined
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
      if (first !== undefined) noteRecord(threadId, turn.turnId, first.uuid);
    }
    await keepCopy(threadId, copied.value.copy, keyOfLast(all) ?? cloud.shown);
    turn.finish({ status: "completed" }, null);
  };

  // One idle copy runs at a time per thread; a turn's copies skip the queue, and an idle copy made while a turn ran is dropped.
  const copyOf = (threadId: string, cloudSessionId: string) =>
    copies.run(threadId, () => fetchCopy(threadId, cloudSessionId));

  const fetchCopy = async (
    threadId: string,
    cloudSessionId: string,
  ): Promise<Result<Copied, CopyFailure>> => {
    if (halted.has(threadId)) {
      return Result.err({
        _tag: "CloudCopyStopped",
        stopped: "ran_model",
        message: COPY_STOPPED,
      });
    }
    const startedAt = now();
    const copied = await copy(cloudSessionId);
    if (copied.isErr()) {
      const { stopped } = copied.error;
      if (stopped !== null) halted.add(threadId);
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
      return Result.err({
        _tag: read.error._tag,
        stopped: null,
        message: COPY_UNREADABLE,
      });
    }
    const all = mainRecords(read.value);
    log({
      event: "claude_cloud",
      step: "copied",
      records: all.length,
      ms: now() - startedAt,
    });
    noticeChildren(threadId, all);
    return Result.ok({ copy: copied.value, records: all });
  };

  // A session a linked one started after the app was last shown gets a chat of its own, once; one started before was the user's to link, and one already linked has its chat.
  const noticeChildren = (threadId: string, all: readonly SessionMessage[]) => {
    // A copy made while a chat is being linked, or one whose link failed, opens nothing.
    const cloud = threads.cloudOf(threadId);
    if (openChild === undefined || cloud === null) return;
    const after = indexAfter(all, cloud.shown);
    const unsent = [...unsentChildren.values()]
      .filter((entry) => entry.threadId === threadId)
      .map((entry) => entry.child);
    for (const child of [...unsent, ...childSessionsIn(all, after)]) {
      if (openedChildren.has(child.sessionId)) continue;
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

  // A copy started for a turn that has ended is removed once it is written.
  const discardStarted = async (started: Started) => {
    const copied = await started.copied;
    if (copied.isOk()) await discardCopy(copied.value.copy);
  };

  // The thread reads the newest copy from now on, so the one it read before is removed once that is saved.
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

  const noteRecord = (threadId: string, turnId: string, record: string) => {
    const known = records.get(threadId) ?? new Map<string, string>();
    known.set(turnId, record);
    records.set(threadId, known);
  };

  // A thread with no turn running is copied now and then; what it shows past where the app was shown opens a turn of Claude's own.
  const tick = async () => {
    for (const threadId of threads.cloudThreadIds()) {
      if (closed) return;
      if (busy.has(threadId) || halted.has(threadId)) continue;
      const cloud = threads.cloudOf(threadId);
      if (cloud === null) continue;
      const reading = threads.sessionIdOf(threadId);
      const copied = await copyOf(threadId, cloud.sessionId);
      // A turn that ran while this copy was made saved a newer one, which this copy may be older than.
      if (
        copied.isErr() ||
        busy.has(threadId) ||
        threads.sessionIdOf(threadId) !== reading
      ) {
        if (copied.isOk()) await discardCopy(copied.value.copy);
        continue;
      }
      const all = copied.value.records;
      const at = indexOf(all, cloud.shown);
      // Claude compacted the session past the record the app was shown, so everything the copy holds came after it and is shown.
      if (cloud.shown !== null && at === -1) {
        log({ event: "claude_cloud", step: "compacted" });
      }
      if (at === all.length - 1 || all.length === 0) {
        await discardCopy(copied.value.copy);
        continue;
      }
      pendingOwn.set(threadId, copied.value);
      if (!startOwnTurn(threadId)) {
        pendingOwn.delete(threadId);
        await keepCopy(threadId, copied.value.copy, cloud.shown);
      }
    }
  };

  const plan = (ms: number) => {
    if (closed) return;
    cancelTick = schedule(() => tick().then(() => plan(IDLE_MS)), ms);
  };

  const stopFollowing = (threadId: string) => {
    const follow = follows.get(threadId);
    if (follow === undefined) return false;
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
    const follow = follows.get(turn.threadId);
    if (follow === undefined || follow.stop) return "steer_not_sent";
    if (input.images.length > 0) return "cloud_images";
    // Counted before it is sent, so a reply that arrives meanwhile does not end the turn before this message is answered.
    follow.texts.push(input.text);
    follow.sending += 1;
    const sendStartedAt = now();
    const sent = await sendToCloud(
      cloud.sessionId,
      input.text,
      turn.record.worktree,
    );
    follow.sending -= 1;
    if (sent.kind !== "sent") forget(follow, input.text);
    if (sent.kind === "rejected") {
      log({ event: "claude_cloud", step: "send_rejected" });
      return "cloud_not_sent";
    }
    // The message may have reached the session, so it is taken rather than refused, which would run it again as a turn; the thread is left with an unknown outcome to check before going on.
    if (sent.kind === "unknown") {
      log({ event: "claude_cloud", step: "send_unknown" });
      turn.markOutcomeUnknown();
      turn.apply(
        renderNotice(
          turn.state(),
          refusalMessage("cloud_send_unknown"),
          "commentary",
          now(),
        ),
      );
      return null;
    }
    log({ event: "claude_cloud", step: "sent", ms: now() - sendStartedAt });
    return null;
  };

  return {
    compactPrompt: inner.compactPrompt,
    closeSession: (threadId) => inner.closeSession(threadId),
    pauseMessages: (threadId) => inner.pauseMessages(threadId),
    recordOf: (threadId, turnId) =>
      records.get(threadId)?.get(turnId) ?? inner.recordOf(threadId, turnId),
    run,
    steer,
    // Stopping only ends the wait; the Cloud session keeps working, which only claude.ai can stop.
    interrupt: (turn, repeated) => {
      if (threads.cloudOf(turn.threadId) !== null) {
        stopFollowing(turn.threadId);
        return;
      }
      inner.interrupt(turn as RunningTurn<Tag>, repeated);
    },
    dropSession: (threadId, link) => inner.dropSession(threadId, link),
    noteFork: (threadId) => inner.noteFork(threadId),
    threadBusy: (threadId) => {
      busy.add(threadId);
      inner.threadBusy(threadId);
    },
    threadIdle: (threadId) => {
      busy.delete(threadId);
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
      for (const threadId of follows.keys()) stopFollowing(threadId);
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

// A short reply comes within the first seconds, so copies overlap then (see waitForReply); after that they come less often, since every copy starts claude and rewrites the whole session.
// A failing copy may end at once, so it is not tried again without a wait.
const pollMs = (waited: number, failing: boolean) => {
  if (failing) return FAST_POLL_MS;
  if (waited < BACK_TO_BACK_FOR_MS) return 0;
  return waited < FAST_POLL_FOR_MS ? FAST_POLL_MS : POLL_MS;
};

// Besides what the user typed, the first message of a chat another chat opened with create_thread, such as harnexus-task cloud does, can link it; it arrives wrapped in its delegation, as its <prompt>.
const commandText = (input: TurnInput) => {
  const typed = typedText(input);
  if (typed !== null || input.toolOutput?.name !== "create_thread")
    return typed;
  return DELEGATED_PROMPT.exec(input.text)?.[1] ?? null;
};

const DELEGATED_PROMPT =
  /^\s*<codex_delegation>[\s\S]*?<prompt>([\s\S]*?)<\/prompt>\s*<\/codex_delegation>\s*$/;

const cloudCommandOf = (text: string | null) => {
  const matched = text === null ? null : CLOUD_COMMAND.exec(text.trim());
  return matched === null ? null : (matched[1] ?? "");
};

const CLOUD_COMMAND = /^\/cloud(?:\s+(\S+))?\s*$/;

const UNSENT_OUTCOMES = new Set(["not_sent", "no_project", "no_parent"]);

// A message whose send failed is no longer waited for; one not yet matched is taken from the end, so the order of the others stays.
const forget = (follow: Follow, text: string) => {
  const at = follow.texts.lastIndexOf(text);
  if (at >= follow.matched) follow.texts.splice(at, 1);
};

const samePrompt = (message: SessionMessage, text: string) =>
  promptTextOf(message)?.trim() === text.trim();

const keyOf = (message: SessionMessage | undefined) => message?.uuid ?? null;

const keyOfLast = (all: readonly SessionMessage[]) => keyOf(all.at(-1));

const indexOf = (all: readonly SessionMessage[], key: string | null) =>
  key === null ? -1 : all.findIndex((message) => message.uuid === key);

// Where the records after uuid start; a record no longer in the copy, such as one Claude compacted away, leaves nothing to skip.
const indexAfter = (all: readonly SessionMessage[], uuid: string | null) => {
  const at = indexOf(all, uuid);
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
      return { event: entry.event, step: entry.step, outcome: entry.outcome };
    case "copied":
      return {
        event: entry.event,
        step: entry.step,
        records: entry.records,
        ms: entry.ms,
      };
    case "copy_failed":
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

const FIRST_TICK_MS = 15_000;

const WAIT_LIMIT_MS = 60 * 60_000;

// Measured in time rather than tries, since the wait between copies changes.
const COPY_FAILING_LIMIT_MS = 20_000;
