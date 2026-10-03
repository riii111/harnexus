import type {
  CanUseTool,
  EffortLevel,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type InferErr,
  type InferOk,
  Result,
  TaggedError,
} from "better-result";
import type { EffortRule } from "../../infra/claude/models.ts";
import type {
  ClaudeSessionSettings,
  claudeSessionExists,
  startClaudeSession,
} from "../../infra/claude/session.ts";
import type { createCodexLink } from "../../infra/codex/codex-link.ts";
import type { ServerRequest } from "../../infra/codex/server-requests.ts";
import type { ThreadRecord } from "../../infra/thread-store.ts";
import { promptFor } from "../../presentation/permission.ts";
import {
  NO_PLAN,
  renderPlan,
  type ThreadPlan,
} from "../../presentation/plan.ts";
import type { TokenUsageBreakdown } from "../../presentation/protocol.ts";
import {
  RECORD_ADVANCED,
  sessionReplyText,
} from "../../presentation/session-reply.ts";
import {
  breakdown,
  NO_USAGE,
  renderTokenUsage,
  type ThreadUsage,
} from "../../presentation/token-usage.ts";
import {
  markToolDeclined,
  renderInterimResult,
  renderNotice,
  renderSdkMessage,
  renderToolRequest,
  runningToolItem,
  runsAgent,
  type TurnOutcome,
} from "../../presentation/turn.ts";
import type { TurnEvent } from "../controller.ts";
import type { Subagents } from "../subagents.ts";
import { type Refusal, refusalMessage } from "../thread-request.ts";
import type { ThreadValues } from "../thread-values.ts";
import type {
  ErrorTag,
  RunningTurn,
  TurnLink,
  TurnRuntime,
} from "../turn-runtime.ts";
import { createInbox, type Inbox } from "./inbox.ts";
import {
  createSessionCommands,
  type SessionCommand,
  type SessionEvent,
} from "./session-commands.ts";
import { readSkills } from "./skill-attachments.ts";

type SessionCommandsDeps = Parameters<typeof createSessionCommands>[0];

type SessionStart = Awaited<ReturnType<typeof startClaudeSession>>;

type ClaudeSession = InferOk<SessionStart>;

type StartSession = (
  settings: ClaudeSessionSettings,
  signal: AbortSignal,
) => Promise<SessionStart>;

type FindSession = (
  sessionId: string,
) => ReturnType<typeof claudeSessionExists>;

type CodexLink = Pick<
  ReturnType<typeof createCodexLink>,
  | "server"
  | "allowedTools"
  | "hasUnsettledWrite"
  | "stopWrites"
  | "acceptWrites"
>;

type RenameThread = (
  threadId: string,
  name: string,
) => Promise<Result<unknown, { _tag: ErrorTag<ReturnType<ServerRequest>> }>>;

type StreamedMessage =
  ClaudeSession["messages"] extends AsyncGenerator<infer R> ? R : never;

type StreamedNext = IteratorResult<StreamedMessage, void>;

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
  | ForkNotSeparate["_tag"]
  | ForkPointUnknown["_tag"]
  | "SteerUnconfirmed";

type SessionStartup = {
  turn: RunningTurn<ClaudeFailureTag>;
  controller: AbortController;
  link: CodexLink | null;
};

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

// A session is not reused until its interrupt reports whether a send is still queued, which can arrive after the interrupted turn has ended.
// attachedSkills maps each SKILL.md path this session was given to the body it was given.
// reader is the inbox Claude's messages go to, and unclaimed says whom it waits for while no turn reads it: a turn Claude started on its own, or the turn the thread has accepted. discarding drops the rest of a turn of Claude's own that the app could not show, and backgroundTasks counts the tasks Claude runs in the background.
type SessionSlot = {
  session: ClaudeSession;
  model: string;
  pendingInterrupt: Promise<void> | null;
  link: CodexLink;
  attachedSkills: Map<string, string>;
  reader: Inbox<StreamedNext> | null;
  unclaimed: "own" | "turn" | null;
  discarding: boolean;
  backgroundTasks: number;
};

// Steers wait in unsentSteers until the turn's own prompt reaches Claude, then stay in pendingSteers until a result names them as taken; sends holds the uuid of every message the turn sent Claude.
// command marks a turn the bridge answers itself, such as /session, own one Claude started on its own, holding one opened only to show approvals no other turn could, and completed one Claude ended with a successful result.
type ClaudeTurn = {
  command: boolean;
  own: boolean;
  holding: boolean;
  completed: boolean;
  slot: SessionSlot | null;
  unsentSteers: string[];
  pendingSteers: Set<string>;
  sends: Set<string>;
  steers: number;
};

// turn stays null until the app is shown the holding turn, and ended declines every approval in it once its Claude is gone.
type HeldApprovals = {
  turn: RunningTurn<ClaudeFailureTag> | null;
  waiting: number;
  answered: () => void;
  ended: AbortController;
};

// signal also ends once the held turn's Claude is gone.
type Approval = { held: HeldApprovals | null; signal: AbortSignal };

class BridgeClosing extends TaggedError("BridgeClosing")<{
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

// A thread keeps one Claude session across turns; a session that fails is dropped and the next turn resumes it from the stored session id.
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
  effortRule,
  subagents,
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
  effortRule: EffortRule;
  subagents: Pick<
    Subagents,
    "start" | "message" | "decline" | "complete" | "settle"
  >;
}): TurnRuntime<ClaudeFailureTag> => {
  type Turn = RunningTurn<ClaudeFailureTag>;

  const sessions = new Map<string, SessionSlot>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const usages = new Map<string, ThreadUsage>();
  const plans = new Map<string, ThreadPlan>();
  const turns = new WeakMap<Turn, ClaudeTurn>();
  const runningTurns = new Map<string, Turn>();
  const startingSessions = new Map<string, SessionStartup>();
  const busyThreads = new Set<string>();
  const commands = createSessionCommands({
    threads,
    listConversations,
    lastRecordOf,
    findSession,
    log,
    now,
  });
  let closed = false;
  let startOwnTurn = (_threadId: string) => false;
  const turnWaiters = new Map<string, (() => void)[]>();
  const heldApprovals = new Map<string, HeldApprovals>();

  const beginSessionStart = (turn: Turn): SessionStartup => {
    const startup: SessionStartup = {
      turn,
      controller: new AbortController(),
      link: null,
    };
    startingSessions.set(turn.threadId, startup);
    return startup;
  };

  const clearSessionStart = (threadId: string, startup: SessionStartup) => {
    if (startingSessions.get(threadId) === startup) {
      startingSessions.delete(threadId);
    }
  };

  const cancelSessionStart = (threadId: string, startup: SessionStartup) => {
    if (startingSessions.get(threadId) !== startup) return;
    startingSessions.delete(threadId);
    startup.controller.abort();
    startup.link?.stopWrites();
  };

  // Each worker keeps its own Claude process, so an idle one is closed; without a session id its next turn could not resume the conversation, so it stays.
  // Closing would end the tasks Claude runs in the background, so the close waits until none is left.
  const scheduleIdleClose = (threadId: string) => {
    cancelIdleClose(threadId);
    const timer = setTimeout(() => {
      idleTimers.delete(threadId);
      const slot = sessions.get(threadId);
      if (slot === undefined) return;
      if (threads.sessionIdOf(threadId) == null) return;
      if (slot.backgroundTasks > 0) {
        scheduleIdleClose(threadId);
        return;
      }
      dropSession(threadId, slot);
      log({ event: "claude_turn", step: "idle_closed" });
    }, idleSessionMs);
    timer.unref();
    idleTimers.set(threadId, timer);
  };

  const cancelIdleClose = (threadId: string) => {
    clearTimeout(idleTimers.get(threadId));
    idleTimers.delete(threadId);
  };

  const run = async (turn: Turn) => {
    // A turn of Claude's own leaves a /resume listing for the user's pick that follows.
    const command =
      turn.input.startedBy === "claude"
        ? null
        : commands.take(turn.threadId, typedText(turn.input));
    const claude: ClaudeTurn = {
      command: command !== null,
      own: false,
      holding: false,
      completed: false,
      slot: null,
      unsentSteers: [],
      pendingSteers: new Set(),
      sends: new Set(),
      steers: 0,
    };
    turns.set(turn, claude);
    if (command !== null) {
      await answerCommand(turn, command);
      return;
    }
    // Approvals open their turn only on a thread with no other turn accepted, so a turn of Claude's own starting while they wait for it is that one.
    const held =
      turn.input.startedBy === "claude"
        ? heldApprovals.get(turn.threadId)
        : undefined;
    if (held?.turn === null) {
      claude.holding = true;
      await holdApprovals(turn, held);
      return;
    }
    runningTurns.set(turn.threadId, turn);
    // A turn of Claude's own is shown only once it holds what Claude sent.
    if (turn.input.startedBy === "app") showTurn(turn.threadId);
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

  // The turn shows what the user typed and the bridge's reply, and nothing reaches Claude or its record.
  const answerCommand = async (turn: Turn, command: SessionCommand) => {
    if (turn.state().interrupting) {
      turn.finish({ status: "interrupted" }, null);
      return;
    }
    const reply = await commands.answer(
      turn.threadId,
      turn.record.worktree,
      command,
    );
    turn.apply(
      renderNotice(
        turn.state(),
        sessionReplyText(reply, now()),
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
    if (reply.name !== null) void nameThread(turn.threadId, reply.name);
    await showPicked(turn);
  };

  // Not awaited, since the thread's next message waits for this turn and the name only changes what the app shows; a failed rename leaves the name as it was and the pick still stands.
  const nameThread = async (threadId: string, name: string) => {
    const renamed = await renameThread(threadId, name);
    if (renamed.isErr()) {
      log({
        event: "claude_turn",
        step: "thread_not_renamed",
        error: renamed.error._tag,
      });
    }
  };

  // Sent after the command's own turn ends, so the earlier turns follow it rather than interleave with it.
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
    // The app now holds the turns, so a later reopen need not carry them again.
    threads.takePicked(turn.threadId);
    log({ event: "claude_turn", step: "history_replayed" });
  };

  const stream = async (turn: Turn, claude: ClaudeTurn) => {
    const { threadId, record, model, input } = turn;
    const skills = await readSkills(input.text);
    if (skills.unreadable.length > 0) {
      log({ event: "claude_turn", step: "skill_unreadable" });
    }
    await waitForPendingInterrupt(threadId);
    if (turn.state().interrupting) {
      turn.finish({ status: "interrupted" }, null);
      return;
    }
    let startup: SessionStartup | null = beginSessionStart(turn);
    // A running Claude holds the conversation as it was, so it restarts to resume from the records written elsewhere.
    const result = await waitForAbort(
      commands.advanced(threadId, threads.sessionIdOf(threadId)),
      startup.controller.signal,
    );
    if (result === ABORTED) {
      if (closed) turn.fail(bridgeClosingError());
      else turn.finish({ status: "interrupted" }, null);
      return;
    }
    const advanced = result;
    if (turn.state().interrupting) {
      cancelSessionStart(threadId, startup);
      turn.finish({ status: "interrupted" }, null);
      return;
    }
    if (closed) {
      cancelSessionStart(threadId, startup);
      turn.fail(bridgeClosingError());
      return;
    }
    if (advanced) {
      turn.apply(
        renderNotice(turn.state(), RECORD_ADVANCED, "commentary", now()),
      );
      const stale = sessions.get(threadId);
      if (stale !== undefined) dropSession(threadId, stale);
    }
    const reused = sessions.get(threadId)?.model === model;
    if (reused) {
      clearSessionStart(threadId, startup);
      startup = null;
    }
    const sessionAskedAt = now();
    const slot = await sessionFor(record, model, turn, startup);
    if (startup !== null) clearSessionStart(threadId, startup);
    if (slot.isErr()) {
      if (slot.error._tag === "SessionStartCancelled") {
        if (closed) turn.fail(bridgeClosingError());
        else turn.finish({ status: "interrupted" }, null);
      } else {
        turn.fail(slot.error);
      }
      return;
    }
    const sessionStartMs = reused ? null : now() - sessionAskedAt;
    turn.useLink(slot.value.link);
    // Claude leaves plan mode when a plan is approved, so the mode the app asks for is set again on every turn.
    const mode = await slot.value.session.setPermissionMode(
      input.permissionMode,
    );
    if (mode.isErr()) {
      dropSession(threadId, slot.value);
      turn.fail(mode.error);
      return;
    }
    // Set on every turn, even with none picked, so Claude runs at the level the app shows rather than at project settings, and a restarted session gets it again.
    const effort = effortRule(model, input.effort);
    if (effort !== null) {
      const applied = await slot.value.session.setEffort(effort);
      if (applied.isErr()) {
        dropSession(threadId, slot.value);
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
    // A skill this Claude session already holds goes as its link alone; a new session has lost it, so it is attached again.
    const attached = slot.value.attachedSkills;
    const fresh = skills.skills.filter(
      ({ path, body }) => attached.get(path) !== body,
    );
    if (fresh.length < skills.skills.length) {
      log({ event: "claude_turn", step: "skill_link_only" });
    }
    const inbox = claimReader(slot.value);
    try {
      if (sendPrompt(turn, claude, slot.value, fresh)) {
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

  // The prompt goes only once the turn reads the session, so its reply cannot be taken for a turn of Claude's own.
  const sendPrompt = (
    turn: Turn,
    claude: ClaudeTurn,
    slot: SessionSlot,
    fresh: Awaited<ReturnType<typeof readSkills>>["skills"],
  ) => {
    const sent = slot.session.send(
      turn.input.text,
      fresh.map(({ block }) => block),
    );
    if (sent.isErr()) {
      dropSession(turn.threadId, slot);
      turn.fail(sent.error);
      return false;
    }
    claude.sends.add(sent.value);
    for (const { path, body } of fresh) slot.attachedSkills.set(path, body);
    claude.slot = slot;
    for (const steer of claude.unsentSteers.splice(0)) {
      const steered = sendSteer(claude, slot, steer);
      if (steered.isErr()) {
        dropSession(turn.threadId, slot);
        turn.fail(steered.error);
        return false;
      }
    }
    return true;
  };

  // A turn Claude started on its own has no prompt to send; its messages wait in the inbox the session gave it until the app shows the turn.
  // A turn the app started took them first if it came ahead of this one, which then has nothing to show.
  const streamOwn = async (turn: Turn, claude: ClaudeTurn) => {
    const threadId = turn.threadId;
    await waitForPendingInterrupt(threadId);
    const slot = sessions.get(threadId);
    const inbox = slot?.unclaimed === "own" ? slot.reader : null;
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
    showTurn(threadId);
    // A stop that came while the turn waited to be shown reaches Claude now.
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

  // Claude may ask for a tool before the app has been shown the turn the thread accepted, such as a turn of its own, so the approval waits until a turn is shown or the thread has none left.
  const turnShown = (threadId: string) =>
    new Promise<void>((resolve) => {
      turnWaiters.set(threadId, [
        ...(turnWaiters.get(threadId) ?? []),
        resolve,
      ]);
    });

  const showTurn = (threadId: string) => {
    for (const resolve of turnWaiters.get(threadId) ?? []) resolve();
    turnWaiters.delete(threadId);
  };

  // Claude sent nothing for this turn, so it reads nothing.
  const holdApprovals = async (turn: Turn, held: HeldApprovals) => {
    held.turn = turn;
    showTurn(turn.threadId);
    while (held.waiting > 0) {
      await new Promise<void>((resolve) => {
        held.answered = resolve;
      });
    }
    if (heldApprovals.get(turn.threadId) === held) {
      heldApprovals.delete(turn.threadId);
    }
    turn.finish(heldOutcome(turn, held), null);
  };

  // Ending as completed would read as if each approval had been answered.
  const heldOutcome = (turn: Turn, held: HeldApprovals): TurnOutcome => {
    if (turn.state().interrupting) return { status: "interrupted" };
    if (held.ended.signal.aborted) {
      return { status: "failed", message: APPROVALS_UNANSWERED };
    }
    return { status: "completed" };
  };

  // The last record of each fork's source when the fork was made, null when the source had said nothing yet; a fork whose source could not be read has none.
  const forkPoints = new Map<string, { at: string | null }>();

  const noteFork = async (threadId: string) => {
    const source = threads.forkSourceOf(threadId);
    if (source === null) return;
    const read = await lastRecordOf(source);
    if (read.isOk()) forkPoints.set(threadId, { at: read.value });
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
    const forkedFrom = threads.forkSourceOf(threadId);
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
        dropSession(threadId, slot);
        turn.fail(received.error);
        return;
      }
      const current = received.value.session_id;
      // A fork that Claude kept in its source's conversation would write into it, so it stops before taking that conversation's id.
      if (current !== undefined && current === forkedFrom) {
        dropSession(threadId, slot);
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
        await threads.setSessionId(threadId, current);
      }
      const message = received.value;
      // Status and system messages follow the send at once, so the wait is measured to the first reply of the main conversation, not of a subagent, and a turn without one logs null.
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
      const usage = renderTokenUsage(
        usages.get(threadId) ?? NO_USAGE,
        message,
        { threadId, turnId: turn.turnId, model, now: now() },
      );
      usages.set(threadId, usage.usage);
      if (usage.notification !== null) send(usage.notification);
      const plan = renderPlan(plans.get(threadId) ?? NO_PLAN, message, {
        threadId,
        turnId: turn.turnId,
        now: now(),
      });
      plans.set(threadId, plan.plan);
      if (plan.notification !== null) send(plan.notification);
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
        dropSession(threadId, slot);
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
        dropSession(threadId, slot);
      }
    }
  };

  // One loop reads each session for its whole life, so what Claude does while no turn reads, such as starting a turn of its own when a background task reports back, is seen as it happens.
  const pump = async (threadId: string, slot: SessionSlot) => {
    while (true) {
      const next = await slot.session.messages.next();
      track(threadId, slot, next);
      const inbox = route(threadId, slot, next);
      // The next message waits until the reader has handled this one, as a turn reading the session itself would; a turn holding approvals reads none, so agents stay live and Claude stopping is seen while it waits.
      if (!heldApprovals.has(threadId)) await inbox?.settled();
      if (next.done === true || next.value.isErr()) return;
    }
  };

  // Messages that come while the thread has a turn accepted wait for it, as they did before the turn read the session; with none, a failure or an end leaves the session unusable, so it goes and the next turn resumes the conversation.
  const route = (
    threadId: string,
    slot: SessionSlot,
    next: StreamedNext,
  ): Inbox<StreamedNext> | null => {
    if (slot.reader !== null) {
      slot.reader.push(next);
      return slot.reader;
    }
    // A session already dropped has nothing left for a turn to read.
    if (sessions.get(threadId) !== slot) return null;
    const own = !busyThreads.has(threadId);
    // A turn holding approvals reads nothing, so while one is open or pending only a turn Claude starts waits for the next turn, even with one queued.
    if (own || heldApprovals.has(threadId)) {
      if (next.done === true || next.value.isErr()) {
        dropSession(threadId, slot);
        return null;
      }
      if (slot.discarding) {
        slot.discarding = next.value.value.type !== "result";
        return null;
      }
      if (!startsTurn(next.value.value)) return null;
    }
    // A turn the app cannot be shown, as when the bridge is closing, is left to Claude.
    if (own && !startOwnTurn(threadId)) return null;
    if (own) log({ event: "claude_turn", step: "own_turn" });
    const inbox = createInbox<StreamedNext>();
    inbox.push(next);
    slot.reader = inbox;
    slot.unclaimed = own ? "own" : "turn";
    return inbox;
  };

  // Tracked as each message arrives rather than as it is routed, since what waited for a turn that took none of it is routed again.
  // A Claude that stopped acts on no answer, so the approvals held for it end even while what it said waits for a later turn.
  const track = (threadId: string, slot: SessionSlot, next: StreamedNext) => {
    if (next.done !== true && next.value.isOk()) {
      trackTasks(slot, next.value.value);
      trackSubagents(threadId, next.value.value);
    } else if (sessions.get(threadId) === slot) {
      endHeldApprovals(threadId);
    }
  };

  // An agent Claude starts, in the turn or in the background, shows as a thread of its own under this one, which also gets what the agent says; one an agent starts goes under that agent's thread.
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

  // Messages that came while the thread had a turn accepted, such as a turn Claude started on its own while that turn was being set up, reach the turn ahead of its reply.
  const claimReader = (slot: SessionSlot) => {
    const inbox = createInbox<StreamedNext>();
    for (const next of slot.reader?.drain() ?? []) inbox.push(next);
    slot.reader = inbox;
    slot.unclaimed = null;
    return inbox;
  };

  // What came after the turn's end, such as a turn Claude started right after it, is read as if no turn had been reading.
  const releaseReader = (
    threadId: string,
    slot: SessionSlot,
    inbox: Inbox<StreamedNext>,
  ) => {
    if (slot.reader !== inbox) return;
    slot.reader = null;
    for (const next of inbox.drain()) route(threadId, slot, next);
  };

  // What waited for turns that took none of it, such as a turn Claude started right as the last one ended, is read again once the thread has no turn left.
  // A turn of Claude's own that could not run was shown as failed, so what it held is not shown again.
  const threadIdle = (threadId: string) => {
    busyThreads.delete(threadId);
    heldApprovals.delete(threadId);
    scheduleIdleClose(threadId);
    showTurn(threadId);
    const slot = sessions.get(threadId);
    if (slot?.reader == null || slot.unclaimed === null) return;
    const left = slot.reader.drain();
    const waitedFor = slot.unclaimed;
    slot.reader = null;
    slot.unclaimed = null;
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
    cancelIdleClose(threadId);
  };

  const steer = (turn: Turn, text: string): Refusal | null => {
    const claude = turns.get(turn);
    if (claude === undefined) return "no_running_turn";
    if (claude.command) return "command_not_steerable";
    if (claude.holding) return "approvals_not_steerable";
    if (claude.steers >= MAX_STEERS_PER_TURN) return "too_many_steers";
    if (claude.slot === null) {
      claude.unsentSteers.push(text);
    } else if (sendSteer(claude, claude.slot, text).isErr()) {
      return "steer_not_sent";
    }
    claude.steers += 1;
    return null;
  };

  const sendSteer = (claude: ClaudeTurn, slot: SessionSlot, text: string) => {
    const sent = slot.session.send(text);
    if (sent.isOk()) {
      claude.pendingSteers.add(sent.value);
      claude.sends.add(sent.value);
    }
    return sent;
  };

  // A turn holding approvals has nothing of Claude's to stop, and an interrupt could close the session its agents run in; the stop closed its prompts, so it ends once each is declined.
  const interrupt = (turn: Turn, repeated: boolean) => {
    if (turns.get(turn)?.holding === true) return;
    const threadId = turn.threadId;
    const startup = startingSessions.get(threadId);
    const stoppingStartup = startup?.turn === turn;
    if (stoppingStartup) {
      cancelSessionStart(threadId, startup);
      if (turns.get(turn)?.slot === null) {
        sessions.get(threadId)?.link.stopWrites();
        turn.finish({ status: "interrupted" }, null);
        return;
      }
    }
    const slot = sessions.get(threadId);
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
      dropSession(threadId, slot);
      turn.finish({ status: "interrupted" }, null);
    });
  };

  const waitForPendingInterrupt = async (threadId: string) => {
    await sessions.get(threadId)?.pendingInterrupt;
  };

  // model is the one the turn was accepted with, since a change that arrives while the turn waits applies to the next turn.
  const sessionFor = async (
    record: ThreadRecord,
    model: string,
    turn: Turn,
    startup: SessionStartup | null,
  ): Promise<
    Result<
      SessionSlot,
      | InferErr<SessionStart>
      | BridgeClosing
      | SessionMissing
      | ForkPointUnknown
      | SessionStartCancelled
    >
  > => {
    const existing = sessions.get(record.threadId);
    // A session that failed while no turn read it closed itself before anything dropped it.
    if (existing?.model === model && !existing.session.isClosed()) {
      return Result.ok(existing);
    }
    if (existing !== undefined) dropSession(record.threadId, existing);
    if (closed) return Result.err(bridgeClosingError());
    const pending = startup ?? beginSessionStart(turn);
    const isCurrent = () =>
      startingSessions.get(record.threadId) === pending &&
      !pending.controller.signal.aborted;
    const resume = threads.sessionIdOf(record.threadId);
    if (resume !== null) {
      const found = await waitForAbort(
        sessionFound(resume),
        pending.controller.signal,
      );
      if (found === ABORTED || !isCurrent()) {
        return Result.err(sessionStartCancelled());
      }
      if (!found) {
        clearSessionStart(record.threadId, pending);
        log({ event: "claude_turn", step: "session_missing" });
        void threads.setSessionId(record.threadId, null);
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
      forkFrom === null ? null : forkPoints.get(record.threadId);
    // Without the point it was made at, a fork would take whatever its source said since.
    if (forkPoint === undefined) {
      clearSessionStart(record.threadId, pending);
      return Result.err(
        new ForkPointUnknown({
          message:
            "the conversation this side chat was opened from could not be read, so it cannot start",
        }),
      );
    }
    const forkAt = forkPoint?.at ?? null;
    // A fork whose source had said nothing, or whose source conversation is gone, starts a conversation of its own.
    const forkFound =
      forkFrom === null || forkAt === null
        ? false
        : await waitForAbort(sessionFound(forkFrom), pending.controller.signal);
    if (forkFound === ABORTED) return Result.err(sessionStartCancelled());
    if (!isCurrent()) return Result.err(sessionStartCancelled());
    // Each session gets its own thread tool server, since one server instance serves one Claude process.
    const link = openLink(record.threadId);
    pending.link = link;
    const starting = startSession(
      {
        cwd: record.worktree,
        model,
        ...(forkFound && forkFrom !== null && forkAt !== null
          ? { resume: forkFrom, forkSession: true, resumeAt: forkAt }
          : resumeFrom(resume)),
        mcpServers: { [link.server.name]: link.server },
        allowedTools: link.allowedTools,
        canUseTool: approveTool(record.threadId),
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
      clearSessionStart(record.threadId, pending);
      link.stopWrites();
      return Result.err(started.error);
    }
    clearSessionStart(record.threadId, pending);
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
    sessions.set(record.threadId, slot);
    void pump(record.threadId, slot);
    return Result.ok(slot);
  };

  // A record that cannot be looked up is left for Claude to resume, which reports its own failure.
  const sessionFound = async (sessionId: string) => {
    const found = await findSession(sessionId);
    return found.isErr() || found.value;
  };

  // The SDK reports no message when a call is refused here, so the refusal is recorded on the turn to show its item as declined.
  const approveTool =
    (threadId: string): CanUseTool =>
    async (toolName, input, options) => {
      const approval: Approval = { held: null, signal: options.signal };
      try {
        return await decideTool(threadId, approval, toolName, input, options);
      } finally {
        if (approval.held !== null) leaveHeld(approval.held);
      }
    };

  const decideTool = async (
    threadId: string,
    approval: Approval,
    ...[toolName, input, options]: Parameters<CanUseTool>
  ) => {
    const turn = await turnToAsk(threadId, approval);
    if (turn === undefined || turn.state().interrupting) {
      return declineTool(threadId, turn, options.toolUseID, NO_TURN);
    }
    const block = { id: options.toolUseID, name: toolName, input };
    // A subagent's call shows as its own item while its agent runs in the turn; one from a background agent would outlive the turn, which would close its item as failed, so its prompt carries an id of its own, as does every call a turn holding approvals shows.
    if (options.agentID === undefined && approval.held?.turn !== turn) {
      turn.apply(renderToolRequest(turn.state(), block, now()));
    } else if (runsAgent(turn.state())) {
      turn.apply(renderToolRequest(turn.state(), block, now(), false));
    }
    const item = runningToolItem(turn.state(), options.toolUseID);
    const prompt = promptFor(
      {
        toolName,
        input,
        item,
        title: options.title,
        reason: options.decisionReason,
        defaultToNo: options.defaultToNo === true,
        suggestions: options.suggestions ?? [],
        suppressAlwaysAllow: options.suppressAlwaysAllowRule === true,
      },
      {
        threadId,
        turnId: turn.turnId,
        itemId: item?.id ?? `${turn.turnId}-${options.toolUseID}`,
        now: now(),
      },
    );
    const answer = await turn.ask(
      prompt.method,
      prompt.params,
      approval.signal,
    );
    const decision = prompt.decide(answer);
    return decision.behavior === "deny"
      ? declineTool(threadId, turn, options.toolUseID, decision.message)
      : decision;
  };

  // An approval whose holding turn could not be shown is declined rather than held again, so a thread whose turns cannot run does not keep opening them.
  // A turn the user stopped before the approval was shown cannot show it, while one asked as the user stops a turn showing it is declined with that turn.
  const turnToAsk = async (threadId: string, approval: Approval) => {
    let waited = false;
    while (!closed && !approval.signal.aborted) {
      const turn = openTurn(threadId);
      const held = heldApprovals.get(threadId);
      if (held !== undefined && (held.turn === null || held.turn === turn)) {
        joinHeld(approval, held);
      }
      const stoppedAhead =
        waited &&
        turn?.state().interrupting === true &&
        approval.held?.turn !== turn;
      if (turn !== undefined && !stoppedAhead) return turn;
      if (held === undefined && !busyThreads.has(threadId)) {
        if (approval.held !== null || !openHeld(threadId, approval)) {
          return undefined;
        }
      }
      const shown = await waitForAbort(turnShown(threadId), approval.signal);
      if (shown === ABORTED) return undefined;
      waited = true;
    }
    return undefined;
  };

  const openHeld = (threadId: string, approval: Approval) => {
    const held: HeldApprovals = {
      turn: null,
      waiting: 0,
      answered: () => {},
      ended: new AbortController(),
    };
    heldApprovals.set(threadId, held);
    joinHeld(approval, held);
    if (startOwnTurn(threadId)) {
      log({ event: "claude_turn", step: "approval_turn" });
      return true;
    }
    heldApprovals.delete(threadId);
    approval.held = null;
    return false;
  };

  const joinHeld = (approval: Approval, held: HeldApprovals) => {
    if (approval.held !== null) return;
    held.waiting += 1;
    approval.held = held;
    approval.signal = AbortSignal.any([approval.signal, held.ended.signal]);
  };

  const leaveHeld = (held: HeldApprovals) => {
    held.waiting -= 1;
    if (held.waiting === 0) held.answered();
  };

  // What the app answers can no longer reach a Claude that is gone.
  const endHeldApprovals = (threadId: string) => {
    heldApprovals.get(threadId)?.ended.abort();
  };

  const openTurn = (threadId: string) => {
    const turn =
      runningTurns.get(threadId) ?? heldApprovals.get(threadId)?.turn;
    return turn?.isOpen() ? turn : undefined;
  };

  const declineTool = (
    threadId: string,
    turn: Turn | undefined,
    toolUseId: string,
    message: string,
  ) => {
    subagents.decline(threadId, toolUseId);
    if (turn !== undefined) {
      turn.apply({
        state: markToolDeclined(turn.state(), toolUseId),
        notifications: [],
      });
    }
    return { behavior: "deny" as const, message };
  };

  const dropSession = (threadId: string, slot: SessionSlot) => {
    if (sessions.get(threadId) === slot) {
      sessions.delete(threadId);
      subagents.settle(threadId);
      endHeldApprovals(threadId);
    }
    slot.session.close();
  };

  const dropSessionOf = (threadId: string, link: TurnLink) => {
    const slot = sessions.get(threadId);
    if (slot?.link === link) dropSession(threadId, slot);
  };

  // Closing ends each active turn's message stream, so no Claude process outlives the bridge.
  const closeAll = () => {
    closed = true;
    for (const threadId of [...idleTimers.keys()]) cancelIdleClose(threadId);
    for (const threadId of [...turnWaiters.keys()]) showTurn(threadId);
    for (const [threadId, startup] of [...startingSessions]) {
      cancelSessionStart(threadId, startup);
    }
    for (const [threadId, slot] of sessions) dropSession(threadId, slot);
  };

  return {
    compactPrompt: COMPACT_PROMPT,
    run,
    steer,
    interrupt,
    dropSession: dropSessionOf,
    noteFork,
    threadBusy,
    threadIdle,
    listen: (start) => {
      startOwnTurn = start;
    },
    closeAll,
  };
};

export const isClaudeTurnEvent = (
  entry: ClaudeLogEvent,
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

// A list under its cap names every send the turn took, so a steer it leaves out runs as a later turn, even one that reached Claude after this result was written; a queued send the CLI counts promises that turn too.
// A capped list or the single last uuid of an older CLI may leave out a steer already taken, so with nothing counted as queued whether the steer runs is unknown.
// A failed result ends the turn, since the steer's run would otherwise hide its error.
const steersAfter = (
  pendingSteers: Set<string>,
  interrupting: boolean,
  result: SDKResultMessage,
): "none" | "queued" | "unknown" => {
  const listed = result.user_message_uuids;
  for (const uuid of takenUuids(result)) pendingSteers.delete(uuid);
  if (interrupting) return "none";
  if (result.subtype !== "success" || result.is_error) return "none";
  if (pendingSteers.size === 0) return "none";
  const complete = listed !== undefined && listed.length < TAKEN_UUIDS_LIMIT;
  return complete || (result.queued_turn_count ?? 0) > 0 ? "queued" : "unknown";
};

// Claude also runs turns of its own, such as when a background task it started reports back, and one that ran while nothing read the session reaches the next turn ahead of that turn's reply.
// A result naming sends answers the turn only if one is the turn's; one naming none is Claude's own only when it says where its prompt came from, since a crashed worker's result or an older CLI's names nothing either.
const answersTurn = (result: SDKResultMessage, sends: Set<string>) => {
  const taken = takenUuids(result);
  if (taken.length > 0) return taken.some((uuid) => sends.has(uuid));
  return result.origin === undefined || result.origin.kind === "human";
};

const takenUuids = (result: SDKResultMessage) =>
  result.user_message_uuids ??
  (result.user_message_uuid === undefined ? [] : [result.user_message_uuid]);

// Claude starts every turn with its init message, then streams its reply; a subagent's messages or a background task's report alone start none.
const startsTurn = (message: SDKMessage) => {
  switch (message.type) {
    case "system":
      return message.subtype === "init";
    case "stream_event":
    case "assistant":
      return message.parent_tool_use_id === null;
    case "result":
      return true;
    default:
      return false;
  }
};

// Tasks Claude marks as ambient, such as a watcher, are no activity a user waits on.
const trackTasks = (slot: SessionSlot, message: SDKMessage) => {
  if (message.type !== "system") return;
  if (message.subtype !== "background_tasks_changed") return;
  slot.backgroundTasks = message.tasks.filter(
    (task) => task.ambient !== true,
  ).length;
};

// Only what the user typed can be a session command, never another thread's message or a compaction.
const typedText = (input: RunningTurn<string>["input"]) =>
  input.toolOutput === null && input.items.length > 0 ? input.text : null;

const resumeFrom = (sessionId: string | null) =>
  sessionId === null ? {} : { resume: sessionId };

const ABORTED = Symbol("aborted");

const waitForAbort = <T>(pending: Promise<T>, signal: AbortSignal) =>
  new Promise<T | typeof ABORTED>((resolve, reject) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    const abort = () => {
      signal.removeEventListener("abort", abort);
      resolve(ABORTED);
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });

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

// A stopped or killed agent ended because someone stopped it, as an interrupted turn does.
const agentOutcome = (status: string, summary: string): TurnOutcome => {
  switch (status) {
    case "completed":
      return { status: "completed" };
    case "failed":
      return { status: "failed", message: summary || AGENT_FAILED };
    default:
      return { status: "interrupted" };
  }
};

const AGENT_FAILED = "The agent failed";

const IDLE_SESSION_MS = 10 * 60_000;

const NO_TURN = "no Claude turn is running to ask the app for approval";

const APPROVALS_UNANSWERED =
  "Claude's session ended before the approval was answered";

// The SDK documents user_message_uuids as holding at most this many entries.
const TAKEN_UUIDS_LIMIT = 64;

// With the prompt, a turn's sends stay under the list cap, so the list names each of them.
const MAX_STEERS_PER_TURN = TAKEN_UUIDS_LIMIT - 2;

const STEER_UNCONFIRMED =
  "Claude may not have received the last steer; send it again if it was not answered";
