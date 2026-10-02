import type {
  CanUseTool,
  EffortLevel,
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
} from "../../presentation/turn.ts";
import type { TurnEvent } from "../controller.ts";
import { type Refusal, refusalMessage } from "../thread-request.ts";
import type { ThreadValues } from "../thread-values.ts";
import type {
  ErrorTag,
  RunningTurn,
  TurnLink,
  TurnRuntime,
} from "../turn-runtime.ts";
import {
  createSessionCommands,
  type SessionCommand,
  type SessionEvent,
} from "./session-commands.ts";
import { readSkills } from "./skill-attachments.ts";

type SessionCommandsDeps = Parameters<typeof createSessionCommands>[0];

type SessionStart = Awaited<ReturnType<typeof startClaudeSession>>;

type ClaudeSession = InferOk<SessionStart>;

type StartSession = (settings: ClaudeSessionSettings) => Promise<SessionStart>;

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

type StreamedMessage =
  ClaudeSession["messages"] extends AsyncGenerator<infer R> ? R : never;

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
  | "SteerUnconfirmed";

type ClaudeTurnEvent =
  | {
      event: "claude_turn";
      step:
        | "idle_closed"
        | "session_missing"
        | "skill_unreadable"
        | "skill_link_only";
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
  | SessionEvent;

export type ClaudeLogEvent = TurnEvent<ClaudeFailureTag> | ClaudeTurnEvent;

// A session is not reused until its interrupt reports whether a send is still queued, which can arrive after the interrupted turn has ended.
// attachedSkills maps each SKILL.md path this session was given to the body it was given.
type SessionSlot = {
  session: ClaudeSession;
  model: string;
  pendingInterrupt: Promise<void> | null;
  link: CodexLink;
  attachedSkills: Map<string, string>;
};

// Steers wait in unsentSteers until the turn's own prompt reaches Claude, then stay in pendingSteers until a result names them as taken.
// command marks a turn the bridge answers itself, such as /session, and completed one Claude ended with a successful result.
type ClaudeTurn = {
  command: boolean;
  completed: boolean;
  slot: SessionSlot | null;
  unsentSteers: string[];
  pendingSteers: Set<string>;
  steers: number;
};

class BridgeClosing extends TaggedError("BridgeClosing")<{
  message: string;
}> {}

class StreamEnded extends TaggedError("StreamEnded")<{
  message: string;
}> {}

class SessionMissing extends TaggedError("SessionMissing")<{
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
  send,
  log,
  now = Date.now,
  idleSessionMs = IDLE_SESSION_MS,
  effortRule,
}: {
  threads: ThreadValues;
  startSession: StartSession;
  findSession: FindSession;
  listConversations: SessionCommandsDeps["listConversations"];
  lastRecordOf: SessionCommandsDeps["lastRecordOf"];
  openLink: (threadId: string) => CodexLink;
  send: (message: object) => void;
  log: (event: ClaudeTurnEvent) => void;
  now?: () => number;
  idleSessionMs?: number;
  effortRule: EffortRule;
}): TurnRuntime<ClaudeFailureTag> => {
  type Turn = RunningTurn<ClaudeFailureTag>;

  const sessions = new Map<string, SessionSlot>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const usages = new Map<string, ThreadUsage>();
  const plans = new Map<string, ThreadPlan>();
  const turns = new WeakMap<Turn, ClaudeTurn>();
  const runningTurns = new Map<string, Turn>();
  const commands = createSessionCommands({
    threads,
    listConversations,
    lastRecordOf,
    findSession,
    log,
    now,
  });
  let closed = false;

  // Each worker keeps its own Claude process, so an idle one is closed; without a session id its next turn could not resume the conversation, so it stays.
  const scheduleIdleClose = (threadId: string) => {
    cancelIdleClose(threadId);
    const timer = setTimeout(() => {
      idleTimers.delete(threadId);
      const slot = sessions.get(threadId);
      if (slot === undefined) return;
      if (threads.sessionIdOf(threadId) == null) return;
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
    const command = commands.take(turn.threadId, typedText(turn.input));
    const claude: ClaudeTurn = {
      command: command !== null,
      completed: false,
      slot: null,
      unsentSteers: [],
      pendingSteers: new Set(),
      steers: 0,
    };
    turns.set(turn, claude);
    if (command !== null) {
      await answerCommand(turn, command);
      return;
    }
    runningTurns.set(turn.threadId, turn);
    await stream(turn, claude);
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
    // A running Claude holds the conversation as it was, so it restarts to resume from the records written elsewhere.
    if (await commands.advanced(threadId, threads.sessionIdOf(threadId))) {
      turn.apply(
        renderNotice(turn.state(), RECORD_ADVANCED, "commentary", now()),
      );
      const stale = sessions.get(threadId);
      if (stale !== undefined) dropSession(threadId, stale);
    }
    const reused = sessions.get(threadId)?.model === model;
    const sessionAskedAt = now();
    const slot = await sessionFor(record, model);
    if (slot.isErr()) {
      turn.fail(slot.error);
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
    const sent = slot.value.session.send(
      input.text,
      fresh.map(({ block }) => block),
    );
    if (sent.isErr()) {
      dropSession(threadId, slot.value);
      turn.fail(sent.error);
      return;
    }
    for (const { path, body } of fresh) attached.set(path, body);
    claude.slot = slot.value;
    for (const steer of claude.unsentSteers.splice(0)) {
      const steered = sendSteer(claude, slot.value, steer);
      if (steered.isErr()) {
        dropSession(threadId, slot.value);
        turn.fail(steered.error);
        return;
      }
    }
    const sentAt = now();
    let firstMessageMs: number | null = null;
    let sessionId = threads.sessionIdOf(threadId);
    while (!turn.state().finished) {
      const next = await slot.value.session.messages.next();
      const received =
        next.done === true
          ? Result.err(
              new StreamEnded({
                message: "Claude stopped before the turn finished",
              }),
            )
          : next.value;
      if (received.isErr()) {
        dropSession(threadId, slot.value);
        turn.fail(received.error);
        return;
      }
      const current = received.value.session_id;
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
        attached.clear();
      }
      if (message.type === "result") {
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
      // Its items stay in this turn, since the app has no turn of Claude's own to show them in.
      if (message.type === "result" && ranOnItsOwn(message)) {
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
        dropSession(threadId, slot.value);
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
        dropSession(threadId, slot.value);
      }
    }
  };

  const steer = (turn: Turn, text: string): Refusal | null => {
    const claude = turns.get(turn);
    if (claude === undefined) return "no_running_turn";
    if (claude.command) return "command_not_steerable";
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
    if (sent.isOk()) claude.pendingSteers.add(sent.value);
    return sent;
  };

  const interrupt = (turn: Turn, repeated: boolean) => {
    const threadId = turn.threadId;
    const slot = sessions.get(threadId);
    slot?.link.stopWrites();
    if (slot === undefined || repeated || slot.pendingInterrupt !== null) {
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
  ): Promise<
    Result<SessionSlot, InferErr<SessionStart> | BridgeClosing | SessionMissing>
  > => {
    const existing = sessions.get(record.threadId);
    if (existing?.model === model) return Result.ok(existing);
    if (existing !== undefined) dropSession(record.threadId, existing);
    if (closed) {
      return Result.err(
        new BridgeClosing({ message: refusalMessage("bridge_closing") }),
      );
    }
    const resume = threads.sessionIdOf(record.threadId);
    if (resume !== null && !(await sessionFound(resume))) {
      log({ event: "claude_turn", step: "session_missing" });
      void threads.setSessionId(record.threadId, null);
      return Result.err(
        new SessionMissing({
          message:
            "Claude's record of this conversation is gone, so it cannot continue; send again to start a new Claude conversation in this thread",
        }),
      );
    }
    // Each session gets its own thread tool server, since one server instance serves one Claude process.
    const link = openLink(record.threadId);
    const started = await startSession({
      cwd: record.worktree,
      model,
      ...resumeFrom(resume),
      mcpServers: { [link.server.name]: link.server },
      allowedTools: link.allowedTools,
      canUseTool: approveTool(record.threadId),
    });
    if (started.isErr()) return Result.err(started.error);
    // Shutdown may have happened while Claude was starting.
    if (closed) {
      started.value.close();
      return Result.err(
        new BridgeClosing({ message: refusalMessage("bridge_closing") }),
      );
    }
    const slot: SessionSlot = {
      session: started.value,
      model,
      pendingInterrupt: null,
      link,
      attachedSkills: new Map(),
    };
    sessions.set(record.threadId, slot);
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
      const turn = openTurn(threadId);
      if (turn === undefined || turn.state().interrupting) {
        return declineTool(turn, options.toolUseID, NO_TURN);
      }
      const block = { id: options.toolUseID, name: toolName, input };
      // A subagent's call has no item in the thread, so its prompt carries an id of its own.
      if (options.agentID === undefined) {
        turn.apply(renderToolRequest(turn.state(), block, now()));
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
        options.signal,
      );
      const decision = prompt.decide(answer);
      return decision.behavior === "deny"
        ? declineTool(turn, options.toolUseID, decision.message)
        : decision;
    };

  const openTurn = (threadId: string) => {
    const turn = runningTurns.get(threadId);
    return turn?.isOpen() ? turn : undefined;
  };

  const declineTool = (
    turn: Turn | undefined,
    toolUseId: string,
    message: string,
  ) => {
    if (turn !== undefined) {
      turn.apply({
        state: markToolDeclined(turn.state(), toolUseId),
        notifications: [],
      });
    }
    return { behavior: "deny" as const, message };
  };

  const dropSession = (threadId: string, slot: SessionSlot) => {
    if (sessions.get(threadId) === slot) sessions.delete(threadId);
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
    for (const [threadId, slot] of sessions) dropSession(threadId, slot);
  };

  return {
    compactPrompt: COMPACT_PROMPT,
    run,
    steer,
    interrupt,
    dropSession: dropSessionOf,
    threadBusy: cancelIdleClose,
    threadIdle: scheduleIdleClose,
    closeAll,
  };
};

export const isClaudeTurnEvent = (
  entry: ClaudeLogEvent,
): entry is ClaudeTurnEvent => Object.hasOwn(CLAUDE_STEPS, entry.step);

export const serializeClaudeTurnEvent = (entry: ClaudeTurnEvent) => {
  switch (entry.step) {
    case "idle_closed":
    case "session_missing":
    case "skill_unreadable":
    case "skill_link_only":
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

// Claude runs a turn of its own when a background task it started reports back, and one that ran while nothing read the session reaches the next turn ahead of that turn's reply; it took no send, so it ends neither the turn nor its steers.
const ranOnItsOwn = (result: SDKResultMessage) =>
  result.origin?.kind === "task-notification" &&
  takenUuids(result).length === 0;

const takenUuids = (result: SDKResultMessage) =>
  result.user_message_uuids ??
  (result.user_message_uuid === undefined ? [] : [result.user_message_uuid]);

// Only what the user typed can be a session command, never another thread's message or a compaction.
const typedText = (input: RunningTurn<string>["input"]) =>
  input.toolOutput === null && input.items.length > 0 ? input.text : null;

const resumeFrom = (sessionId: string | null) =>
  sessionId === null ? {} : { resume: sessionId };

const CLAUDE_STEPS: Record<ClaudeTurnEvent["step"], true> = {
  idle_closed: true,
  session_missing: true,
  skill_unreadable: true,
  skill_link_only: true,
  effort_applied: true,
  metrics: true,
  interrupt_failed: true,
  session_command: true,
  record_advanced: true,
  record_unreadable: true,
};

const COMPACT_PROMPT = "/compact";

const IDLE_SESSION_MS = 10 * 60_000;

const NO_TURN = "no Claude turn is running to ask the app for approval";

// The SDK documents user_message_uuids as holding at most this many entries.
const TAKEN_UUIDS_LIMIT = 64;

// With the prompt, a turn's sends stay under the list cap, so the list names each of them.
const MAX_STEERS_PER_TURN = TAKEN_UUIDS_LIMIT - 2;

const STEER_UNCONFIRMED =
  "Claude may not have received the last steer; send it again if it was not answered";
