import type {
  EffortLevel,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { type InferErr, Result, TaggedError } from "better-result";
import type { ImageBlock, ResizeImage } from "../../infra/claude/images.ts";
import type { EffortRule } from "../../infra/claude/models.ts";
import type { Prompt } from "../../infra/claude/prompt-queue.ts";
import type {
  ClaudeSessionSettings,
  claudeSessionExists,
} from "../../infra/claude/session.ts";
import type { ServerRequest } from "../../infra/codex/server-requests.ts";
import type { ThreadRecord } from "../../infra/thread-store.ts";
import type { TokenUsageBreakdown } from "../../presentation/protocol.ts";
import { RECOVERY_CONTEXT } from "../../presentation/recovery.ts";
import {
  type PickerPage,
  pickerPrompt,
  searchPrompt,
} from "../../presentation/session-picker.ts";
import {
  RECORD_ADVANCED,
  sessionReplyText,
} from "../../presentation/session-reply.ts";
import { breakdown } from "../../presentation/token-usage.ts";
import {
  renderInterimResult,
  renderNotice,
  renderSdkMessage,
  type TurnOutcome,
} from "../../presentation/turn.ts";
import { ABORTED, waitForAbort } from "../../runtime/wait-for-abort.ts";
import type { TurnEvent } from "../controller.ts";
import type { Subagents } from "../subagents.ts";
import { type Refusal, refusalMessage } from "../thread-request.ts";
import type { ThreadValues } from "../thread-values.ts";
import type {
  ErrorTag,
  RunningTurn,
  ThreadEnd,
  TurnLink,
  TurnRuntime,
} from "../turn-runtime.ts";
import { createApprovals } from "./approvals.ts";
import { createForkPoints } from "./fork-points.ts";
import { readImages } from "./image-attachments.ts";
import { createInbox, type Inbox } from "./inbox.ts";
import {
  createSessionCommands,
  type SessionCommand,
  type SessionEvent,
  sessionCommandOf,
} from "./session-commands.ts";
import {
  type ClaudeSession,
  type CodexLink,
  createSessionSlots,
  type SessionSlot,
  type SessionStart,
  type SessionStartup,
  type StreamedMessage,
  type StreamedNext,
} from "./session-slots.ts";
import { readSkills } from "./skill-attachments.ts";
import { createThreadDisplay } from "./thread-display.ts";
import { createTurnRecords } from "./turn-records.ts";

type SessionCommandsDeps = Parameters<typeof createSessionCommands>[0];

type StartSession = (
  settings: ClaudeSessionSettings,
  signal: AbortSignal,
) => Promise<SessionStart>;

type FindSession = (
  sessionId: string,
) => ReturnType<typeof claudeSessionExists>;

type RenameThread = (
  threadId: string,
  name: string,
) => Promise<Result<unknown, { _tag: ErrorTag<ReturnType<ServerRequest>> }>>;

type InterruptTag = ErrorTag<ReturnType<ClaudeSession["interrupt"]>>;

type ClaudeFailureTag =
  | ErrorTag<SessionStart>
  | ErrorTag<ReturnType<ClaudeSession["send"]>>
  | ErrorTag<ReturnType<ClaudeSession["setPermissionMode"]>>
  | ErrorTag<ReturnType<ClaudeSession["setEffort"]>>
  | InferErr<StreamedMessage>["_tag"]
  | InterruptTag
  | BridgeClosing["_tag"]
  | StreamEnded["_tag"]
  | SessionMissing["_tag"]
  | SessionNotSaved["_tag"]
  | ForkNotSeparate["_tag"]
  | ForkPointUnknown["_tag"]
  | ImageFailureTag
  | "SteerUnconfirmed";

type ImageFailureTag = InferErr<Awaited<ReturnType<typeof readImages>>>["_tag"];

type ClaudeTurnEvent =
  | {
      event: "claude_turn";
      step:
        | "idle_closed"
        | "own_turn"
        | "approval_turn"
        | "session_missing"
        | "skill_unreadable"
        | "skill_link_only"
        | "history_replayed";
    }
  | { event: "claude_turn"; step: "effort_applied"; effort: EffortLevel }
  | ({
      event: "claude_turn";
      step: "metrics";
      model: string;
      effort: EffortLevel | null;
      compaction: boolean;
      sessionStartMs: number | null;
      firstMessageMs: number | null;
      turnMs: number;
    } & TokenUsageBreakdown)
  | { event: "claude_turn"; step: "interrupt_failed"; error: InterruptTag }
  | {
      event: "claude_turn";
      step: "thread_not_renamed";
      error: ErrorTag<ReturnType<ServerRequest>>;
    }
  | SessionEvent;

export type ClaudeLogEvent = TurnEvent<ClaudeFailureTag> | ClaudeTurnEvent;

// steering settles once the last steer accepted has been sent or refused, so a steer still reading its images keeps the ones after it waiting.
type ClaudeTurn = {
  command: AbortController | null;
  own: boolean;
  holdsApprovals: boolean;
  completed: boolean;
  slot: SessionSlot | null;
  unsentSteers: Prompt[];
  pendingSteers: Set<string>;
  sends: Set<string>;
  steers: number;
  steering: Promise<unknown>;
};

class BridgeClosing extends TaggedError("BridgeClosing")<{
  message: string;
}> {}

class SessionNotSaved extends TaggedError("SessionNotSaved")<{
  message: string;
}> {}

class SessionStartCancelled extends TaggedError("SessionStartCancelled")<{
  message: string;
}> {}

class StreamEnded extends TaggedError("StreamEnded")<{
  message: string;
}> {}

class SessionMissing extends TaggedError("SessionMissing")<{
  message: string;
}> {}

class ForkNotSeparate extends TaggedError("ForkNotSeparate")<{
  message: string;
}> {}

class ForkPointUnknown extends TaggedError("ForkPointUnknown")<{
  message: string;
}> {}

export const createClaudeRuntime = ({
  threads,
  startSession,
  findSession,
  listConversations,
  lastRecordOf,
  openLink,
  renameThread,
  readHistory = async () => [],
  send,
  log,
  now = Date.now,
  idleSessionMs = IDLE_SESSION_MS,
  permissionMode = "auto",
  effortRule,
  subagents,
  resizeImage,
}: {
  threads: ThreadValues;
  startSession: StartSession;
  findSession: FindSession;
  listConversations: SessionCommandsDeps["listConversations"];
  lastRecordOf: SessionCommandsDeps["lastRecordOf"];
  openLink: (threadId: string) => CodexLink;
  renameThread: RenameThread;
  readHistory?: (
    threadId: string,
    sessionId: string,
    cwd: string,
  ) => Promise<readonly object[]>;
  send: (message: object) => void;
  log: (event: ClaudeTurnEvent) => void;
  now?: () => number;
  idleSessionMs?: number;
  permissionMode?: "default" | "auto";
  effortRule: EffortRule;
  subagents: Pick<
    Subagents,
    "start" | "message" | "decline" | "complete" | "settle" | "forget"
  >;
  resizeImage: ResizeImage;
}): TurnRuntime<ClaudeFailureTag> => {
  type Turn = RunningTurn<ClaudeFailureTag>;

  const turns = new WeakMap<Turn, ClaudeTurn>();
  const runningTurns = new Map<string, Turn>();
  const busyThreads = new Set<string>();
  const pausedMessages = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const commands = createSessionCommands({
    threads,
    listConversations,
    lastRecordOf,
    findSession,
    log,
    now,
  });
  const turnRecords = createTurnRecords();
  const display = createThreadDisplay({ send, now });
  const forkPoints = createForkPoints({ threads, lastRecordOf });
  let closed = false;
  let startOwnTurn = (_threadId: string) => false;
  const approvals = createApprovals<ClaudeFailureTag>({
    permissionMode,
    now,
    log,
    subagents,
    isClosed: () => closed,
    runningTurnOf: (threadId) => runningTurns.get(threadId),
    isBusy: (threadId) => busyThreads.has(threadId),
    pausedOf: (threadId) => pausedMessages.get(threadId)?.promise,
    startOwnTurn: (threadId) => startOwnTurn(threadId),
  });
  const slots = createSessionSlots<Turn>({
    threads,
    idleSessionMs,
    log,
    onDropped: (threadId) => {
      subagents.settle(threadId);
      approvals.end(threadId);
    },
  });

  const endCancelledStart = (turn: Turn) => {
    if (closed) turn.fail(bridgeClosingError());
    else turn.finish({ status: "interrupted" }, null);
  };

  const run = async (turn: Turn) => {
    const command =
      turn.input.startedBy === "claude"
        ? null
        : sessionCommandOf(sessionCommandTextOf(turn.input));
    const claude: ClaudeTurn = {
      command: command === null ? null : new AbortController(),
      own: false,
      holdsApprovals: false,
      completed: false,
      slot: null,
      unsentSteers: [],
      pendingSteers: new Set(),
      sends: new Set(),
      steers: 0,
      steering: Promise.resolve(),
    };
    turns.set(turn, claude);
    if (command !== null && claude.command !== null) {
      await answerCommand(turn, command, claude.command);
      return;
    }
    if (
      turn.recovering &&
      turn.record.sessionId === null &&
      threads.sessionIdOf(turn.threadId) === null &&
      turn.record.rewind === undefined
    ) {
      turn.fail(
        new SessionMissing({
          message:
            "the previous Claude conversation could not be restored; use /resume to select it or repair the saved state before continuing",
        }),
      );
      return;
    }
    // Approvals open their turn only on a thread with no other turn accepted, so a turn of Claude's own starting while they wait for it is that one.
    const held =
      turn.input.startedBy === "claude"
        ? approvals.awaitingTurn(turn.threadId)
        : undefined;
    if (held !== undefined) {
      claude.holdsApprovals = true;
      // Claude sent nothing for this turn, so it reads nothing.
      await approvals.hold(turn, held);
      return;
    }
    runningTurns.set(turn.threadId, turn);
    if (turn.input.startedBy === "app") approvals.showTurn(turn.threadId);
    if (turn.input.startedBy === "claude") await streamOwn(turn, claude);
    else await stream(turn, claude);
    if (runningTurns.get(turn.threadId) === turn) {
      runningTurns.delete(turn.threadId);
    }
    // A turn cut short may still be writing records, which would read as the conversation continuing elsewhere.
    if (claude.completed) {
      await commands.remember(
        turn.threadId,
        threads.sessionIdOf(turn.threadId),
      );
    } else {
      commands.forget(turn.threadId);
    }
  };

  const answerCommand = async (
    turn: Turn,
    command: SessionCommand,
    stop: AbortController,
  ) => {
    if (turn.state().interrupting) {
      turn.finish({ status: "interrupted" }, null);
      return;
    }
    let asked = 0;
    const nextItemId = () => `${turn.turnId}-resume-${++asked}`;
    const reply = await commands.answer(
      turn.threadId,
      turn.record.worktree,
      command,
      (page) => askPick(turn, page, nextItemId, stop),
    );
    turn.apply(
      renderNotice(
        turn.state(),
        sessionReplyText(reply),
        "final_answer",
        now(),
      ),
    );
    turn.finish(
      turn.state().interrupting
        ? { status: "interrupted" }
        : { status: "completed" },
      null,
    );
    if (reply.kind !== "selected") return;
    // Not awaited, since the thread's next message waits for this turn and the name only changes what the app shows.
    if (reply.name !== null) void nameThread(turn.threadId, reply.name);
    // Sent after the command's own turn ends, so the earlier turns follow it rather than interleave with it.
    await showPicked(turn);
  };

  const askPick = async (
    turn: Turn,
    page: PickerPage,
    nextItemId: () => string,
    stop: AbortController,
  ) => {
    const target = () => ({
      threadId: turn.threadId,
      turnId: turn.turnId,
      // The questions belong to no item of the turn, so each one carries an id of its own.
      itemId: nextItemId(),
    });
    const listed = pickerPrompt(target(), page, now());
    const picked = listed.answerOf(
      await turn.ask(listed.method, listed.params, stop.signal),
    );
    if (picked.kind !== "searching") return picked;
    const search = searchPrompt(target());
    return search.answerOf(
      await turn.ask(search.method, search.params, stop.signal),
    );
  };

  const nameThread = async (threadId: string, name: string) => {
    const renamed = await renameThread(threadId, name);
    // A failed rename leaves the name as it was and the pick still stands.
    if (renamed.isErr()) {
      log({
        event: "claude_turn",
        step: "thread_not_renamed",
        error: renamed.error._tag,
      });
    }
  };

  const showPicked = async (turn: Turn) => {
    const sessionId = threads.sessionIdOf(turn.threadId);
    if (sessionId === null) return;
    const replayed = await readHistory(
      turn.threadId,
      sessionId,
      turn.record.worktree,
    );
    if (replayed.length === 0) return;
    for (const notification of replayed) send(notification);
    threads.consumePick(turn.threadId);
    log({ event: "claude_turn", step: "history_replayed" });
  };

  const stream = async (turn: Turn, claude: ClaudeTurn) => {
    const { threadId, record, model, input } = turn;
    const skills = await readSkills(input.text);
    if (skills.unreadable.length > 0) {
      log({ event: "claude_turn", step: "skill_unreadable" });
    }
    const images = await readImages(input.images, resizeImage);
    if (images.isErr()) {
      turn.fail({
        _tag: images.error._tag,
        message: refusalMessage(images.error.refusal),
      });
      return;
    }
    await waitForPendingInterrupt(threadId);
    if (turn.state().interrupting) {
      turn.finish({ status: "interrupted" }, null);
      return;
    }
    // A session closes itself on its stream's end, and replacing it would drop what Claude said before the end while waiting for this turn; an end alone leaves nothing to show, so the turn runs on a new session.
    const stopped = slots.slotOf(threadId);
    if (
      stopped?.session.isClosed() &&
      stopped.unclaimed === "turn" &&
      stopped.reader?.queued().some(saidSomething) === true
    ) {
      const inbox = claimReader(stopped);
      try {
        await read(turn, claude, stopped, inbox, {
          effort: effortRule(model, input.effort),
          sessionStartMs: null,
          sentAt: now(),
        });
      } finally {
        releaseReader(threadId, stopped, inbox);
      }
      return;
    }
    let startup: SessionStartup<Turn> | null = slots.beginStart(turn);
    // A running Claude holds the conversation as it was, so it restarts to resume from the records written elsewhere.
    const result = await waitForAbort(
      commands.advanced(threadId, threads.sessionIdOf(threadId)),
      startup.controller.signal,
    );
    if (result === ABORTED) {
      endCancelledStart(turn);
      return;
    }
    const advanced = result;
    if (turn.state().interrupting) {
      slots.cancelStart(threadId, startup);
      turn.finish({ status: "interrupted" }, null);
      return;
    }
    if (closed) {
      slots.cancelStart(threadId, startup);
      turn.fail(bridgeClosingError());
      return;
    }
    if (advanced) {
      turn.apply(
        renderNotice(turn.state(), RECORD_ADVANCED, "commentary", now()),
      );
      const stale = slots.slotOf(threadId);
      if (stale !== undefined) slots.drop(threadId, stale);
    }
    const reused = slots.slotOf(threadId)?.model === model;
    if (reused) {
      slots.clearStart(threadId, startup);
      startup = null;
    }
    const sessionAskedAt = now();
    const slot = await sessionFor(record, model, turn, startup);
    if (startup !== null) slots.clearStart(threadId, startup);
    if (slot.isErr()) {
      if (slot.error._tag === "SessionStartCancelled") {
        endCancelledStart(turn);
      } else {
        turn.fail(slot.error);
      }
      return;
    }
    const sessionStartMs = reused ? null : now() - sessionAskedAt;
    turn.useLink(slot.value.link);
    // Claude leaves plan mode when a plan is approved, so the mode the app asks for is set again on every turn.
    const mode = await slot.value.session.setPermissionMode(
      input.permissionMode === "plan" ? "plan" : permissionMode,
    );
    if (mode.isErr()) {
      slots.drop(threadId, slot.value);
      turn.fail(mode.error);
      return;
    }
    // Set on every turn, even with none picked, so Claude runs at the level the app shows rather than at project settings, and a restarted session gets it again.
    const effort = effortRule(model, input.effort);
    if (effort !== null) {
      const applied = await slot.value.session.setEffort(effort);
      if (applied.isErr()) {
        slots.drop(threadId, slot.value);
        turn.fail(applied.error);
        return;
      }
      log({ event: "claude_turn", step: "effort_applied", effort });
    }
    if (turn.state().interrupting) {
      turn.finish({ status: "interrupted" }, null);
      return;
    }
    slot.value.link.acceptWrites();
    // A new session has lost the skills an earlier one held, so they are attached again.
    const attached = slot.value.attachedSkills;
    const fresh = skills.skills.filter(
      ({ path, body }) => attached.get(path) !== body,
    );
    if (fresh.length < skills.skills.length) {
      log({ event: "claude_turn", step: "skill_link_only" });
    }
    // The turn reads the session before its prompt goes, so the reply cannot be taken for a turn of Claude's own.
    const inbox = claimReader(slot.value);
    try {
      if (sendPrompt(turn, claude, slot.value, images.value, fresh)) {
        await read(turn, claude, slot.value, inbox, {
          effort,
          sessionStartMs,
          sentAt: now(),
        });
      }
    } finally {
      releaseReader(threadId, slot.value, inbox);
    }
  };

  const sendPrompt = (
    turn: Turn,
    claude: ClaudeTurn,
    slot: SessionSlot,
    images: readonly ImageBlock[],
    fresh: Awaited<ReturnType<typeof readSkills>>["skills"],
  ) => {
    const reference = threads.referenceOf(turn.threadId);
    const sent = slot.session.send({
      text: turn.input.text,
      images,
      attachments: [
        ...(turn.recovering ? [RECOVERY_CONTEXT] : []),
        ...(reference === null ? [] : [reference]),
        ...fresh.map(({ block }) => block),
      ],
    });
    if (sent.isErr()) {
      slots.drop(turn.threadId, slot);
      turn.fail(sent.error);
      return false;
    }
    turnRecords.note(turn.threadId, turn.turnId, sent.value);
    claude.sends.add(sent.value);
    for (const { path, body } of fresh) slot.attachedSkills.set(path, body);
    claude.slot = slot;
    for (const steer of claude.unsentSteers.splice(0)) {
      const steered = sendSteer(claude, slot, steer);
      if (steered.isErr()) {
        slots.drop(turn.threadId, slot);
        turn.fail(steered.error);
        return false;
      }
    }
    return true;
  };

  const streamOwn = async (turn: Turn, claude: ClaudeTurn) => {
    const threadId = turn.threadId;
    await waitForPendingInterrupt(threadId);
    const slot = slots.slotOf(threadId);
    const inbox = slot?.unclaimed === "own" ? slot.reader : null;
    // A turn the app started ahead of this one took Claude's waiting messages, so this one has nothing to show.
    if (slot === undefined || inbox == null) {
      turn.finish(
        turn.state().interrupting
          ? { status: "interrupted" }
          : { status: "completed" },
        null,
      );
      return;
    }
    slot.unclaimed = null;
    claude.own = true;
    claude.slot = slot;
    turn.useLink(slot.link);
    slot.link.acceptWrites();
    approvals.showTurn(threadId);
    if (turn.state().interrupting) interrupt(turn, false);
    try {
      await read(turn, claude, slot, inbox, {
        effort: effortRule(turn.model, turn.input.effort),
        sessionStartMs: null,
        sentAt: now(),
      });
    } finally {
      releaseReader(threadId, slot, inbox);
    }
  };

  const read = async (
    turn: Turn,
    claude: ClaudeTurn,
    slot: SessionSlot,
    inbox: Inbox<StreamedNext>,
    {
      effort,
      sessionStartMs,
      sentAt,
    }: {
      effort: EffortLevel | null;
      sessionStartMs: number | null;
      sentAt: number;
    },
  ) => {
    const { threadId, model } = turn;
    let firstMessageMs: number | null = null;
    let sessionId = threads.sessionIdOf(threadId);
    const forkedFrom =
      threads.rewindOf(threadId)?.sessionId ?? threads.forkSourceOf(threadId);
    while (!turn.state().finished) {
      const next = await inbox.take();
      const received =
        next.done === true
          ? Result.err(
              new StreamEnded({
                message: "Claude stopped before the turn finished",
              }),
            )
          : next.value;
      if (received.isErr()) {
        slots.drop(threadId, slot);
        turn.fail(received.error);
        return;
      }
      const current = received.value.session_id;
      // A fork that Claude kept in its source's conversation would write into it, so it stops before taking that conversation's id.
      if (current !== undefined && current === forkedFrom) {
        slots.drop(threadId, slot);
        turn.fail(
          new ForkNotSeparate({
            message:
              "Claude continued the original conversation instead of a copy, so this side chat stopped",
          }),
        );
        return;
      }
      if (current !== undefined && current !== sessionId) {
        sessionId = current;
        const saved = await threads.setSessionId(threadId, current);
        if (
          saved.isErr() &&
          (turn.recovering || turn.record.rewind !== undefined)
        ) {
          turn.markOutcomeUnknown();
          slots.drop(threadId, slot);
          turn.fail(
            new SessionNotSaved({
              message:
                "the Claude conversation could not be saved; check the state directory permissions before continuing",
            }),
          );
          return;
        }
      }
      const message = received.value;
      // Status and system messages follow the send at once, so the wait is measured to the first reply of the main conversation, not of a subagent.
      if (
        (message.type === "stream_event" || message.type === "assistant") &&
        message.parent_tool_use_id === null
      ) {
        firstMessageMs ??= now() - sentAt;
      }
      // A compaction summarizes the skills attached so far and a reset such as /clear drops them, so the next turn attaches them again.
      if (
        (message.type === "system" && message.subtype === "compact_boundary") ||
        message.type === "conversation_reset"
      ) {
        slot.attachedSkills.clear();
      }
      const foreign =
        message.type === "result" &&
        !claude.own &&
        !answersTurn(message, claude.sends);
      if (message.type === "result" && !foreign) {
        log({
          event: "claude_turn",
          step: "metrics",
          model,
          effort,
          compaction: turn.compaction,
          ...breakdown(message.usage),
          sessionStartMs,
          firstMessageMs,
          turnMs: now() - turn.startedAtMs,
        });
      }
      // Sent before the message is rendered, so a result's usage reaches the app ahead of turn/completed.
      display.show(turn, message);
      // A turn Claude started on its own just as this one sent its prompt reaches it ahead of its reply, and its items stay in this turn.
      if (message.type === "result" && foreign) {
        turn.apply(renderInterimResult(turn.state(), message, now()));
        continue;
      }
      const steers =
        message.type === "result"
          ? steersAfter(
              claude.pendingSteers,
              turn.state().interrupting,
              message,
            )
          : "none";
      if (message.type === "result" && steers !== "none") {
        turn.apply(renderInterimResult(turn.state(), message, now()));
        if (steers === "queued") continue;
        // The steer may never run, so the user is told to send it again, and the session goes so a late run cannot leak into the next turn.
        slots.drop(threadId, slot);
        turn.finish(
          { status: "failed", message: STEER_UNCONFIRMED },
          "SteerUnconfirmed",
        );
        return;
      }
      turn.apply(renderSdkMessage(turn.state(), message, now()));
      if (message.type === "result") {
        claude.completed =
          message.subtype === "success" &&
          !message.is_error &&
          !turn.state().interrupting;
      }
      // A failed result leaves its steers unrun, so the session goes with them rather than run them into the next turn; after a stop, the interrupt receipt decides instead.
      const state = turn.state();
      if (
        state.finished &&
        !state.interrupting &&
        claude.pendingSteers.size > 0
      ) {
        slots.drop(threadId, slot);
      }
    }
  };

  // Reads and routes a session's messages for the session's whole life.
  const pump = async (threadId: string, slot: SessionSlot) => {
    // Read even while no turn reads, so Claude starting a turn of its own when a background task reports back is seen as it happens.
    while (true) {
      const next = await slot.session.messages.next();
      const paused = pausedMessages.get(threadId);
      if (paused !== undefined) {
        await paused.promise;
        if (slots.slotOf(threadId) !== slot) return;
      }
      track(threadId, slot, next);
      const inbox = route(threadId, slot, next);
      // The next message waits until the reader has handled this one, as a turn reading the session itself would.
      // An approval turn never reads, so waiting would freeze agents' threads and hide Claude stopping.
      if (!approvals.isHeld(threadId)) await inbox?.settled();
      if (next.done === true || next.value.isErr()) return;
    }
  };

  const route = (
    threadId: string,
    slot: SessionSlot,
    next: StreamedNext,
  ): Inbox<StreamedNext> | null => {
    if (slot.reader !== null) {
      slot.reader.push(next);
      return slot.reader;
    }
    if (slots.slotOf(threadId) !== slot) return null;
    const own = !busyThreads.has(threadId);
    // A turn holding approvals reads nothing, so while one is open or pending only a turn Claude starts waits for the next turn, even with one queued.
    if (own || approvals.isHeld(threadId)) {
      if (next.done === true || next.value.isErr()) {
        slots.drop(threadId, slot);
        return null;
      }
      if (slot.discarding) {
        slot.discarding = next.value.value.type !== "result";
        return null;
      }
      if (!startsTurn(next.value.value)) return null;
    }
    if (own && !startOwnTurn(threadId)) return null;
    if (own) log({ event: "claude_turn", step: "own_turn" });
    const inbox = createInbox<StreamedNext>();
    inbox.push(next);
    slot.reader = inbox;
    slot.unclaimed = own ? "own" : "turn";
    return inbox;
  };

  const track = (threadId: string, slot: SessionSlot, next: StreamedNext) => {
    if (next.done !== true && next.value.isOk()) {
      // Tracked as each message arrives rather than as it is routed, since what waited for a turn that took none of it is routed again.
      trackTasks(slot, next.value.value);
      trackSubagents(threadId, next.value.value);
    } else if (slots.slotOf(threadId) === slot) {
      // A Claude that stopped acts on no answer, so the approvals held for it end even while what it said waits for a later turn.
      approvals.end(threadId);
    }
  };

  const trackSubagents = (threadId: string, message: SDKMessage) => {
    if (message.type !== "system") {
      subagents.message(threadId, message);
      return;
    }
    if (
      message.subtype === "task_started" &&
      message.task_type === "local_agent" &&
      message.tool_use_id !== undefined
    ) {
      subagents.start({
        threadId,
        turnId: runningTurns.get(threadId)?.turnId ?? null,
        toolUseId: message.tool_use_id,
        taskId: message.task_id,
        description: message.description || null,
        agentType: message.subagent_type ?? null,
        cwd: threads.threadOf(threadId)?.cwd ?? "",
        prompt: message.prompt ?? null,
        depth: message.spawn_depth ?? 1,
      });
    } else if (message.subtype === "task_notification") {
      subagents.complete(
        threadId,
        message.task_id,
        agentOutcome(message.status, message.summary),
      );
    } else if (
      message.subtype === "task_updated" &&
      (message.patch.status === "killed" ||
        message.patch.status === "completed" ||
        (message.patch.status === "failed" &&
          message.patch.error !== undefined))
    ) {
      subagents.complete(
        threadId,
        message.task_id,
        agentOutcome(message.patch.status, message.patch.error ?? ""),
      );
    }
  };

  const claimReader = (slot: SessionSlot) => {
    const inbox = createInbox<StreamedNext>();
    for (const next of slot.reader?.drain() ?? []) inbox.push(next);
    slot.reader = inbox;
    slot.unclaimed = null;
    return inbox;
  };

  const releaseReader = (
    threadId: string,
    slot: SessionSlot,
    inbox: Inbox<StreamedNext>,
  ) => {
    if (slot.reader !== inbox) return;
    slot.reader = null;
    for (const next of inbox.drain()) route(threadId, slot, next);
  };

  const threadIdle = (threadId: string) => {
    busyThreads.delete(threadId);
    approvals.forget(threadId);
    slots.scheduleIdleClose(threadId);
    approvals.showTurn(threadId);
    const slot = slots.slotOf(threadId);
    if (slot?.reader == null || slot.unclaimed === null) return;
    const left = slot.reader.drain();
    const waitedFor = slot.unclaimed;
    slot.reader = null;
    slot.unclaimed = null;
    // A turn of Claude's own that could not run was shown as failed, so what it held is not shown again.
    if (waitedFor === "own") {
      slot.discarding = !left.some(
        (next) =>
          next.done !== true &&
          next.value.isOk() &&
          next.value.value.type === "result",
      );
      return;
    }
    for (const next of left) route(threadId, slot, next);
  };

  const threadBusy = (threadId: string) => {
    busyThreads.add(threadId);
    slots.cancelIdleClose(threadId);
  };

  const steer = (
    turn: Turn,
    input: Pick<Turn["input"], "text" | "images">,
  ): Promise<Refusal | null> => {
    const claude = turns.get(turn);
    if (claude === undefined) return Promise.resolve("no_running_turn");
    if (claude.command !== null)
      return Promise.resolve("command_not_steerable");
    if (claude.holdsApprovals) {
      return Promise.resolve("approvals_not_steerable");
    }
    if (claude.steers >= MAX_STEERS_PER_TURN) {
      return Promise.resolve("too_many_steers");
    }
    claude.steers += 1;
    const previous = claude.steering;
    const steered = (async () => {
      const images = await readImages(input.images, resizeImage);
      await previous;
      const refusal = images.isErr()
        ? images.error.refusal
        : sendOrQueueSteer(turn, claude, {
            text: input.text,
            images: images.value,
          });
      if (refusal !== null) claude.steers -= 1;
      return refusal;
    })();
    claude.steering = steered;
    return steered;
  };

  const sendOrQueueSteer = (
    turn: Turn,
    claude: ClaudeTurn,
    prompt: Prompt,
  ): Refusal | null => {
    const state = turn.state();
    // A steer whose images were read after its turn ended or was stopped has nothing to join.
    if (turns.get(turn) !== claude || state.finished || state.interrupting) {
      return "steer_not_sent";
    }
    if (claude.slot === null) {
      claude.unsentSteers.push(prompt);
      return null;
    }
    return sendSteer(claude, claude.slot, prompt).isErr()
      ? "steer_not_sent"
      : null;
  };

  const sendSteer = (claude: ClaudeTurn, slot: SessionSlot, prompt: Prompt) => {
    const sent = slot.session.send(prompt);
    if (sent.isOk()) {
      claude.pendingSteers.add(sent.value);
      claude.sends.add(sent.value);
    }
    return sent;
  };

  const interrupt = (turn: Turn, repeated: boolean) => {
    const claude = turns.get(turn);
    // A turn holding approvals has nothing of Claude's to stop, and an interrupt could close the session its agents run in; the stop closed its prompts, so it ends once each is declined.
    if (claude?.holdsApprovals === true) return;
    // A command's turn has nothing of Claude's to stop either; the stop closed its open question, and the abort keeps it from asking another.
    if (claude?.command != null) {
      claude.command.abort();
      return;
    }
    const threadId = turn.threadId;
    const startup = slots.startingOf(threadId);
    const stoppingStartup = startup?.turn === turn;
    if (stoppingStartup) {
      slots.cancelStart(threadId, startup);
      if (turns.get(turn)?.slot === null) {
        slots.slotOf(threadId)?.link.stopWrites();
        turn.finish({ status: "interrupted" }, null);
        return;
      }
    }
    const slot = slots.slotOf(threadId);
    slot?.link.stopWrites();
    if (slot === undefined || repeated || slot.pendingInterrupt !== null) {
      if (stoppingStartup && slot === undefined) {
        turn.finish({ status: "interrupted" }, null);
      }
      return;
    }
    // A send still queued in Claude would run after the interrupt, and an old CLI cannot say whether one is, so either way the session is closed and the next turn resumes it.
    slot.pendingInterrupt = slot.session.interrupt().then((interrupted) => {
      slot.pendingInterrupt = null;
      if (interrupted.isErr()) {
        log({
          event: "claude_turn",
          step: "interrupt_failed",
          error: interrupted.error._tag,
        });
      } else if (interrupted.value?.length === 0) {
        return;
      }
      slots.drop(threadId, slot);
      turn.finish({ status: "interrupted" }, null);
    });
  };

  const waitForPendingInterrupt = async (threadId: string) => {
    await slots.slotOf(threadId)?.pendingInterrupt;
  };

  const sessionFor = async (
    record: ThreadRecord,
    // The one the turn was accepted with, since a change that arrives while the turn waits applies to the next turn.
    model: string,
    turn: Turn,
    startup: SessionStartup<Turn> | null,
  ): Promise<
    Result<
      SessionSlot,
      | InferErr<SessionStart>
      | BridgeClosing
      | SessionMissing
      | SessionNotSaved
      | ForkPointUnknown
      | SessionStartCancelled
    >
  > => {
    const existing = slots.slotOf(record.threadId);
    // A session that failed while no turn read it closed itself before anything dropped it.
    if (existing?.model === model && !existing.session.isClosed()) {
      return Result.ok(existing);
    }
    if (existing !== undefined) slots.drop(record.threadId, existing);
    if (closed) return Result.err(bridgeClosingError());
    const pending = startup ?? slots.beginStart(turn);
    const isCurrent = () =>
      slots.startingOf(record.threadId) === pending &&
      !pending.controller.signal.aborted;
    const rewind = threads.rewindOf(record.threadId);
    const resume =
      rewind === undefined
        ? threads.sessionIdOf(record.threadId)
        : rewind.at === null
          ? null
          : rewind.sessionId;
    if (resume !== null) {
      const found = await waitForAbort(
        sessionFound(resume),
        pending.controller.signal,
      );
      if (found === ABORTED || !isCurrent()) {
        return Result.err(sessionStartCancelled());
      }
      if (!found) {
        slots.clearStart(record.threadId, pending);
        log({ event: "claude_turn", step: "session_missing" });
        const forgotten = await threads.setSessionId(record.threadId, null);
        if (forgotten.isErr() && rewind !== undefined) {
          turn.markOutcomeUnknown();
          return Result.err(
            new SessionNotSaved({
              message:
                "the missing Claude conversation could not be cleared; check the state directory permissions before continuing",
            }),
          );
        }
        return Result.err(
          new SessionMissing({
            message:
              "Claude's record of this conversation is gone, so it cannot continue; send again to start a new Claude conversation in this thread",
          }),
        );
      }
    }
    const forkFrom =
      resume === null ? threads.forkSourceOf(record.threadId) : null;
    const forkPoint =
      forkFrom === null ? null : forkPoints.pointOf(record.threadId);
    // Without the point it was made at, a fork would take whatever its source said since.
    if (forkPoint === undefined) {
      slots.clearStart(record.threadId, pending);
      return Result.err(
        new ForkPointUnknown({
          message:
            "the conversation this side chat was opened from could not be read, so it cannot start",
        }),
      );
    }
    const forkAt = forkPoint?.at ?? null;
    const forkFound =
      forkFrom === null || forkAt === null
        ? false
        : await waitForAbort(sessionFound(forkFrom), pending.controller.signal);
    if (forkFound === ABORTED) return Result.err(sessionStartCancelled());
    if (!isCurrent()) return Result.err(sessionStartCancelled());
    // Each session gets its own thread tool server, since one server instance serves one Claude process.
    const link = openLink(record.threadId);
    pending.link = link;
    const instructions = threads.instructionsOf(record.threadId);
    const starting = startSession(
      {
        threadId: record.threadId,
        cwd: record.worktree,
        model,
        permissionMode:
          turn.input.permissionMode === "plan" ? "plan" : permissionMode,
        ...(rewind !== undefined
          ? rewind.at === null
            ? {}
            : {
                resume: rewind.sessionId,
                forkSession: true,
                resumeAt: rewind.at,
              }
          : forkFound && forkFrom !== null && forkAt !== null
            ? { resume: forkFrom, forkSession: true, resumeAt: forkAt }
            : resumeFrom(resume)),
        toolServers: { [link.server.name]: link.server.tools },
        allowedTools: link.allowedTools,
        canUseTool: approvals.approveTool(record.threadId),
        ...(instructions !== null && { instructions }),
      },
      pending.controller.signal,
    );
    const result = await waitForAbort(starting, pending.controller.signal);
    if (result === ABORTED) {
      void starting.then(
        (late) => {
          if (late.isOk()) late.value.close();
        },
        () => {},
      );
      return Result.err(sessionStartCancelled());
    }
    const started = result;
    if (!isCurrent() || closed) {
      if (started.isOk()) started.value.close();
      return Result.err(
        closed ? bridgeClosingError() : sessionStartCancelled(),
      );
    }
    if (started.isErr()) {
      slots.clearStart(record.threadId, pending);
      link.stopWrites();
      return Result.err(started.error);
    }
    slots.clearStart(record.threadId, pending);
    const slot: SessionSlot = {
      session: started.value,
      model,
      pendingInterrupt: null,
      link,
      attachedSkills: new Map(),
      reader: null,
      unclaimed: null,
      discarding: false,
      backgroundTasks: 0,
    };
    slots.open(record.threadId, slot);
    void pump(record.threadId, slot);
    return Result.ok(slot);
  };

  const sessionFound = async (sessionId: string) => {
    const found = await findSession(sessionId);
    // A record that cannot be looked up is left for Claude to resume, which reports its own failure.
    return found.isErr() || found.value;
  };

  const dropSessionOf = (threadId: string, link: TurnLink) => {
    const slot = slots.slotOf(threadId);
    if (slot?.link === link) slots.drop(threadId, slot);
  };

  const forgetThread = (threadId: string, ended: ThreadEnd) => {
    // The server answered before the thread's work ended, so a thread with a turn, an approval, a session on its way or a paused stream keeps everything.
    if (
      busyThreads.has(threadId) ||
      pausedMessages.has(threadId) ||
      approvals.isHeld(threadId) ||
      slots.startingOf(threadId) !== undefined
    ) {
      return;
    }
    turnRecords.forget(threadId);
    // An archived thread can come back to the same session, which still uses its plan, usage, agents and fork point.
    if (ended === "archived") return;
    display.forget(threadId);
    subagents.forget(threadId);
    forkPoints.forget(threadId);
    slots.close(threadId);
  };

  const closeAll = () => {
    closed = true;
    for (const paused of pausedMessages.values()) paused.resolve();
    pausedMessages.clear();
    approvals.showAllTurns();
    // Closing ends each active turn's message stream, so no Claude process outlives the bridge.
    slots.closeAll();
  };

  return {
    compactPrompt: COMPACT_PROMPT,
    pauseMessages: (threadId) => {
      const paused = Promise.withResolvers<void>();
      pausedMessages.set(threadId, paused);
      return () => {
        if (pausedMessages.get(threadId) === paused)
          pausedMessages.delete(threadId);
        paused.resolve();
      };
    },
    closeSession: slots.close,
    recordOf: turnRecords.recordOf,
    run,
    steer,
    interrupt,
    dropSession: dropSessionOf,
    noteFork: forkPoints.note,
    // A fork handed back to Codex never starts a session again, so its point is dead.
    dropFork: forkPoints.forget,
    forgetThread,
    threadBusy,
    threadIdle,
    listen: (start) => {
      startOwnTurn = start;
    },
    closeAll,
  };
};

export const isClaudeTurnEvent = (
  entry: ClaudeLogEvent | TurnEvent,
): entry is ClaudeTurnEvent => Object.hasOwn(CLAUDE_STEPS, entry.step);

export const serializeClaudeTurnEvent = (entry: ClaudeTurnEvent) => {
  switch (entry.step) {
    case "idle_closed":
    case "own_turn":
    case "approval_turn":
    case "session_missing":
    case "skill_unreadable":
    case "skill_link_only":
    case "history_replayed":
      return { event: entry.event, step: entry.step };
    case "effort_applied":
      return { event: entry.event, step: entry.step, effort: entry.effort };
    case "metrics":
      return {
        event: entry.event,
        step: entry.step,
        model: entry.model,
        effort: entry.effort,
        compaction: entry.compaction,
        inputTokens: entry.inputTokens,
        cachedInputTokens: entry.cachedInputTokens,
        cacheWriteInputTokens: entry.cacheWriteInputTokens,
        outputTokens: entry.outputTokens,
        reasoningOutputTokens: entry.reasoningOutputTokens,
        totalTokens: entry.totalTokens,
        sessionStartMs: entry.sessionStartMs,
        firstMessageMs: entry.firstMessageMs,
        turnMs: entry.turnMs,
      };
    case "session_command":
      return {
        event: entry.event,
        step: entry.step,
        command: entry.command,
        reply: entry.reply,
        error: entry.error,
      };
    case "record_advanced":
      return { event: entry.event, step: entry.step };
    case "interrupt_failed":
    case "thread_not_renamed":
    case "record_unreadable":
      return { event: entry.event, step: entry.step, error: entry.error };
  }
};

// Whether the steers a result left pending run as a later turn, or may not run at all.
const steersAfter = (
  pendingSteers: Set<string>,
  interrupting: boolean,
  result: SDKResultMessage,
): "none" | "queued" | "unknown" => {
  const listed = result.user_message_uuids;
  for (const uuid of takenUuids(result)) pendingSteers.delete(uuid);
  if (interrupting) return "none";
  // A failed result ends the turn, since the steer's run would otherwise hide its error.
  if (result.subtype !== "success" || result.is_error) return "none";
  if (pendingSteers.size === 0) return "none";
  // A list under its cap names every send the turn took, so a steer it leaves out runs later; a capped list or an older CLI's single uuid may leave out one already taken, so without a queued count whether it runs is unknown.
  const complete = listed !== undefined && listed.length < TAKEN_UUIDS_LIMIT;
  return complete || (result.queued_turn_count ?? 0) > 0 ? "queued" : "unknown";
};

// Whether a result answers the turn, rather than a turn Claude ran on its own while nothing read the session.
const answersTurn = (result: SDKResultMessage, sends: Set<string>) => {
  const taken = takenUuids(result);
  if (taken.length > 0) return taken.some((uuid) => sends.has(uuid));
  // A result naming no sends is Claude's own only when it says where its prompt came from, since a crashed worker's result or an older CLI's names nothing either.
  return result.origin === undefined || result.origin.kind === "human";
};

const takenUuids = (result: SDKResultMessage) =>
  result.user_message_uuids ??
  (result.user_message_uuid === undefined ? [] : [result.user_message_uuid]);

const saidSomething = (next: StreamedNext) =>
  next.done !== true && next.value.isOk();

const startsTurn = (message: SDKMessage) => {
  switch (message.type) {
    case "system":
      return message.subtype === "init";
    // A subagent's messages or a background task's report alone start no turn.
    case "stream_event":
    case "assistant":
      return message.parent_tool_use_id === null;
    case "result":
      return true;
    default:
      return false;
  }
};

const trackTasks = (slot: SessionSlot, message: SDKMessage) => {
  if (message.type !== "system") return;
  if (message.subtype !== "background_tasks_changed") return;
  slot.backgroundTasks = message.tasks.filter(
    // Tasks Claude marks as ambient, such as a watcher, are no activity a user waits on.
    (task) => task.ambient !== true,
  ).length;
};

export const sessionCommandTextOf = (input: RunningTurn<string>["input"]) =>
  input.toolOutput === null && input.items.length > 0 ? input.text : null;

const resumeFrom = (sessionId: string | null) =>
  sessionId === null ? {} : { resume: sessionId };

const bridgeClosingError = () =>
  new BridgeClosing({ message: refusalMessage("bridge_closing") });

const sessionStartCancelled = () =>
  new SessionStartCancelled({
    message: "Claude session startup was cancelled",
  });

const CLAUDE_STEPS: Record<ClaudeTurnEvent["step"], true> = {
  idle_closed: true,
  own_turn: true,
  approval_turn: true,
  session_missing: true,
  skill_unreadable: true,
  skill_link_only: true,
  history_replayed: true,
  effort_applied: true,
  metrics: true,
  interrupt_failed: true,
  thread_not_renamed: true,
  session_command: true,
  record_advanced: true,
  record_unreadable: true,
};

const COMPACT_PROMPT = "/compact";

const agentOutcome = (status: string, summary: string): TurnOutcome => {
  switch (status) {
    case "completed":
      return { status: "completed" };
    case "failed":
      return { status: "failed", message: summary || AGENT_FAILED };
    // A stopped or killed agent ended because someone stopped it, as an interrupted turn does.
    default:
      return { status: "interrupted" };
  }
};

const AGENT_FAILED = "The agent failed";

const IDLE_SESSION_MS = 10 * 60_000;

// The SDK documents user_message_uuids as holding at most this many entries.
const TAKEN_UUIDS_LIMIT = 64;

// With the prompt, a turn's sends stay under the list cap, so the list names each of them.
const MAX_STEERS_PER_TURN = TAKEN_UUIDS_LIMIT - 2;

const STEER_UNCONFIRMED =
  "Claude may not have received the last steer; send it again if it was not answered";
