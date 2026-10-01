import { randomUUID } from "node:crypto";
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
import { type EffortRule, isClaudeEffort } from "../infra/claude/models.ts";
import type {
  ClaudeSessionSettings,
  claudeSessionExists,
  startClaudeSession,
} from "../infra/claude/session.ts";
import { createAppRequests } from "../infra/codex/app-requests.ts";
import type { createCodexLink } from "../infra/codex/codex-link.ts";
import { delegatedMessage } from "../infra/codex/delegations.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import type { ThreadRecord, ThreadStore } from "../infra/thread-store.ts";
import { promptFor } from "../presentation/permission.ts";
import { NO_PLAN, renderPlan, type ThreadPlan } from "../presentation/plan.ts";
import type {
  TokenUsageBreakdown,
  UserInput,
} from "../presentation/protocol.ts";
import {
  breakdown,
  NO_USAGE,
  renderTokenUsage,
  type ThreadUsage,
} from "../presentation/token-usage.ts";
import {
  markInterrupting,
  markToolDeclined,
  type Rendered,
  renderInterimResult,
  renderSdkMessage,
  renderToolOutput,
  renderToolRequest,
  renderTurnCompleted,
  renderTurnStarted,
  renderUserInput,
  runningToolItem,
  type TurnOutcome,
  type TurnState,
} from "../presentation/turn.ts";
import { readSkills } from "./skill-attachments.ts";
import {
  type AppRequest,
  checkThread,
  type Mode,
  type Refusal,
  refusalMessage,
  requestedEffort,
  requestedMode,
  savedThreadChange,
  type Thread,
} from "./thread-request.ts";

// Only steps, turn statuses, models, effort levels, token counts, durations, refusal reasons and error tags are logged, never thread ids or text.
// Tag is the failure tags a runtime declares, so only a tag written in code can reach the log as a turn's error.
export type TurnEvent<Tag extends string = string> =
  | ThreadValueEvent
  | {
      event: "claude_turn";
      step:
        | "started"
        | "queued"
        | "outcome_unknown"
        | "steered"
        | "outcome_cleared"
        | "effort_unsupported";
    }
  | {
      event: "claude_turn";
      step: "finished";
      status: TurnOutcome["status"];
      error: Tag | null;
    }
  | {
      event: "claude_turn";
      step: "refused";
      reason: Refusal;
      error: StoreTag | null;
    }
  | {
      event: "claude_turn";
      step: "thread_not_materialized";
      error: ErrorTag<ReturnType<ServerRequest>>;
    }
  | { event: "claude_turn"; step: "run_state_not_saved"; error: StoreTag };

// What the controller hands a runtime for one turn; the runtime reads the turn's state and moves it only through apply, finish and fail, so the order in which the app is told stays with the controller.
type RunningTurn<Tag extends string> = {
  threadId: string;
  turnId: string;
  record: ThreadRecord;
  model: string;
  input: TurnInput;
  compaction: boolean;
  startedAtMs: number;
  state: () => TurnState;
  apply: (rendered: Rendered, error?: Tag | null) => void;
  finish: (outcome: TurnOutcome, error: Tag | null) => void;
  fail: (error: { _tag: Tag; message: string }) => void;
  isOpen: () => boolean;
  useLink: (link: TurnLink) => void;
  ask: (
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

// run sends the turn and reports its progress until it ends; threadBusy and threadIdle mark when the thread has turns accepted and when it has none left.
type TurnRuntime<Tag extends string> = {
  compactPrompt: string;
  run: (turn: RunningTurn<Tag>) => Promise<void>;
  steer: (turn: RunningTurn<Tag>, text: string) => Refusal | null;
  interrupt: (turn: RunningTurn<Tag>, repeated: boolean) => void;
  dropSession: (threadId: string, link: TurnLink) => void;
  threadBusy: (threadId: string) => void;
  threadIdle: (threadId: string) => void;
  closeAll: () => void;
};

type ThreadValues = ReturnType<typeof createThreadValues>;

type ThreadValueEvent =
  | { event: "claude_turn"; step: "model_changed" }
  | { event: "claude_turn"; step: "effort_changed"; effort: EffortLevel }
  | {
      event: "claude_turn";
      step: "session_not_saved" | "model_not_saved" | "effort_not_saved";
      error: StoreTag;
    };

type MaterializeThread = (
  threadId: string,
) => Promise<Result<unknown, { _tag: ErrorTag<ReturnType<ServerRequest>> }>>;

// The thread tool server of the session a turn ran on, read when the turn ends to see whether a write was left undecided.
type TurnLink = Pick<
  ReturnType<typeof createCodexLink>,
  "hasUnsettledWrite" | "stopWrites"
>;

type ErrorTag<R> = InferErr<Awaited<R>> extends { _tag: infer T } ? T : never;

// runWrite is generic in the operation's error, so the store's own tags are listed; a new tag there fails to compile here.
type StoreTag =
  | ErrorTag<ReturnType<ThreadStore["register"]>>
  | ErrorTag<ReturnType<ThreadStore["setSessionId"]>>
  | ErrorTag<ReturnType<ThreadStore["addMessageId"]>>
  | ErrorTag<ReturnType<ThreadStore["addRequester"]>>
  | ErrorTag<ReturnType<ThreadStore["setModel"]>>
  | ErrorTag<ReturnType<ThreadStore["setEffort"]>>
  | "ThreadNotFound"
  | "WriteOutcomeUnknown"
  | "WriteNotStarted"
  | "RunStateNotSaved";

// turn is set once the turn is shown to the app as started, and link by the runtime once its session is up.
type ActiveTurn<Tag extends string> = {
  threadId: string;
  state: TurnState | null;
  turn: RunningTurn<Tag> | null;
  link: TurnLink | null;
};

// answered is set when the app got the turn as soon as it was accepted, so a turn that cannot run is shown as failed rather than refused.
type TurnRequest = {
  id: AppRequest["id"];
  turnId: string;
  answered: boolean;
  stopped: boolean;
  compaction: boolean;
};

type TextInput = {
  items: UserInput[];
  toolOutput: ToolOutput | null;
  text: string;
};

type ToolOutput = NonNullable<
  ReturnType<typeof delegatedMessage>
>["toolOutput"];

// effort is the thread's level when the turn was accepted, so a change made while it waits or runs applies to the next turn.
// requester is the thread that delegated this turn's message, saved before the turn runs so Claude can answer it.
type TurnInput = TextInput & {
  permissionMode: Mode;
  effort: EffortLevel | null;
  requester: string | null;
};

class LinkWriteUnsettled extends TaggedError("LinkWriteUnsettled")<{
  message: string;
}> {}

export const createTurnController = <Tag extends string>({
  store,
  threads,
  runtime,
  materializeThread,
  send,
  log,
  now = Date.now,
  newTurnId = () => `harnexus-turn-${randomUUID()}`,
  effortRule,
}: {
  store: ThreadStore;
  threads: ThreadValues;
  runtime: TurnRuntime<Tag>;
  materializeThread: MaterializeThread;
  send: (message: object) => void;
  log: (event: TurnEvent<Tag>) => void;
  now?: () => number;
  newTurnId?: () => string;
  effortRule: EffortRule;
}) => {
  const activeTurns = new Map<string, ActiveTurn<Tag>>();
  // Message ids accepted but not yet saved, so a copy arriving while the first waits or runs is caught too.
  const acceptedMessageIds = new Map<string, Set<string>>();
  const turnsInFlight = new Map<string, number>();
  // The server keeps a Claude thread in its default mode, so the mode the app picked is remembered here.
  const modes = new Map<string, Mode>();
  const materialized = new Set<string>();
  // A thread with an unknown outcome continues only on a new message the user typed after being told, so neither a resent copy of a refused message nor another thread's message counts.
  const refusedForUnknown = new Map<string, Set<string>>();
  const waitingTurns = new Map<
    string,
    { threadId: string; request: TurnRequest }
  >();
  const appRequests = createAppRequests({ send, now });
  let closed = false;

  // fallbackCwd is the thread's directory as last reported by the server, used when a Codex thread switches to Claude.
  // A turn/start on a busy thread, such as a reviewer's reply, waits in the store's per-thread queue instead of being refused; its sender gives up long before the running turn may end, so it is answered on acceptance.
  const startTurn = (
    { id, params }: AppRequest,
    fallbackCwd: string | undefined,
  ) => {
    const threadId = params.threadId;
    if (typeof threadId !== "string") {
      refuse(id, "missing_thread");
      return;
    }
    const checked = checkThread(
      params,
      threads.threadOf(threadId),
      fallbackCwd,
    );
    if ("refusal" in checked) {
      refuse(id, checked.refusal);
      return;
    }
    const delegated = delegatedMessage(params);
    const owner =
      delegated?.sourceThreadId == null
        ? undefined
        : store.reviewerOwner(delegated.sourceThreadId);
    if (owner !== undefined && owner !== threadId) {
      refuse(id, "reply_to_other_worker");
      return;
    }
    const input = textInput(params.input, delegated);
    if (input === null) {
      refuse(id, "text_only");
      return;
    }
    if (closed) {
      refuse(id, "bridge_closing");
      return;
    }
    const messageId = clientMessageId(params);
    if (messageId !== null && isDelivered(threadId, messageId)) {
      refuse(id, "duplicate_message");
      return;
    }
    if (messageId !== null) acceptMessage(threadId, messageId);
    threads.changeModel(threadId, checked.thread.model);
    // A turn/start without an effort, such as another thread's reply, runs at the thread's level.
    const effort = requestedEffort(params);
    if (effort !== undefined) selectEffort(threadId, effort);
    const turn = {
      ...input,
      permissionMode: selectMode(
        threadId,
        requestedMode(params) ?? modes.get(threadId) ?? "default",
      ),
      effort: threads.pickedEffortOf(threadId),
      requester: requesterOf(
        threadId,
        delegated?.sourceThreadId,
        owner,
        threads.threadOf,
      ),
    };
    acceptTurn(id, threadId, checked.thread, turn, messageId, false);
  };

  // A compaction runs as a turn whose prompt is Claude's /compact, so it waits behind a running turn and meets the same stops and unknown outcomes; the app's empty answer comes on acceptance and the turn's notifications show the rest.
  const compactThread = ({ id, params }: AppRequest) => {
    const threadId = params.threadId;
    if (typeof threadId !== "string") {
      refuse(id, "missing_thread");
      return;
    }
    const checked = checkThread(params, threads.threadOf(threadId), undefined);
    if ("refusal" in checked) {
      refuse(id, checked.refusal);
      return;
    }
    if (closed) {
      refuse(id, "bridge_closing");
      return;
    }
    // Without a conversation Claude only reports there is nothing to compact; a turn already accepted may still start one, and a session whose record vanished is found only when the turn runs, since looking it up here would let a later request start first.
    if (
      threads.sessionIdOf(threadId) === null &&
      !turnsInFlight.has(threadId)
    ) {
      refuse(id, "nothing_to_compact");
      return;
    }
    const turn = {
      items: [],
      toolOutput: null,
      text: runtime.compactPrompt,
      permissionMode: modes.get(threadId) ?? "default",
      effort: threads.pickedEffortOf(threadId),
      requester: null,
    };
    acceptTurn(id, threadId, checked.thread, turn, null, true);
  };

  const acceptTurn = (
    id: AppRequest["id"],
    threadId: string,
    thread: Thread,
    turn: TurnInput,
    messageId: string | null,
    compaction: boolean,
  ) => {
    runtime.threadBusy(threadId);
    const inFlight = turnsInFlight.get(threadId) ?? 0;
    if (inFlight > 0) log({ event: "claude_turn", step: "queued" });
    turnsInFlight.set(threadId, inFlight + 1);
    const request = {
      id,
      turnId: newTurnId(),
      answered: compaction || inFlight > 0,
      stopped: false,
      compaction,
    };
    if (inFlight > 0) waitingTurns.set(request.turnId, { threadId, request });
    if (compaction) {
      send({ id, result: {} });
    } else if (request.answered) {
      const waiting = renderTurnStarted({
        threadId,
        turnId: request.turnId,
        cwd: thread.cwd,
        now: now(),
      });
      send({ id, result: { turn: waiting.turn } });
    }
    void runTurn(request, thread, threadId, turn, messageId).then(() => {
      const left = (turnsInFlight.get(threadId) ?? 1) - 1;
      if (left > 0) {
        turnsInFlight.set(threadId, left);
        return;
      }
      turnsInFlight.delete(threadId);
      runtime.threadIdle(threadId);
    });
  };

  // Claude takes a steer at its next tool boundary, or runs it as its next turn when the running one has ended, and either way the app turn stays open until Claude has taken it.
  const steerTurn = ({ id, params }: AppRequest) => {
    const active = activeTurns.get(String(params.threadId));
    const state = active?.state;
    if (
      active === undefined ||
      active.turn === null ||
      state == null ||
      state.finished ||
      state.interrupting ||
      state.turnId !== params.expectedTurnId
    ) {
      refuse(id, "no_running_turn");
      return;
    }
    // Codex also takes no steer into a compaction, whose prompt Claude runs as a command rather than a conversation turn.
    if (state.compaction) {
      refuse(id, "compaction_not_steerable");
      return;
    }
    const input = textInput(params.input, null);
    if (input === null) {
      refuse(id, "text_only");
      return;
    }
    const refusal = runtime.steer(active.turn, input.text);
    if (refusal !== null) {
      refuse(id, refusal);
      return;
    }
    send({ id, result: { turnId: state.turnId } });
    log({ event: "claude_turn", step: "steered" });
    apply(active, renderUserInput(state, input.items, null, now()));
  };

  // The reply comes first so the app sees it before the interrupted turn completes; a failed interrupt stops Claude by closing the session.
  const interruptTurn = ({ id, params }: AppRequest) => {
    const threadId = String(params.threadId);
    const active = activeTurns.get(threadId);
    if (
      active?.state == null ||
      active.turn === null ||
      active.state.finished ||
      active.state.turnId !== params.turnId
    ) {
      stopWaitingTurn(id, threadId, params.turnId);
      return;
    }
    // A stop while the session already has an interrupt in flight, from this turn or an earlier one, is answered without asking Claude again; that interrupt decides the session, and a turn that has not sent yet stops before sending.
    const repeated = active.state.interrupting;
    active.state = markInterrupting(active.state);
    send({ id, result: {} });
    appRequests.cancel(threadId);
    runtime.interrupt(active.turn, repeated);
  };

  // The running turn's prompts are left open, since the stop is for a turn behind it.
  const stopWaitingTurn = (
    id: AppRequest["id"],
    threadId: string,
    turnId: unknown,
  ) => {
    const waiting =
      typeof turnId === "string" ? waitingTurns.get(turnId) : undefined;
    if (waiting?.threadId !== threadId) {
      refuse(id, "no_running_turn");
      return;
    }
    waiting.request.stopped = true;
    send({ id, result: {} });
  };

  const selectMode = (threadId: string, mode: Mode) => {
    modes.set(threadId, mode);
    return mode;
  };

  // A level only Codex models have, such as minimal or ultra, would leave Claude on some other level, so the thread keeps its own.
  const selectEffort = (threadId: string, effort: string) => {
    if (!isClaudeEffort(effort)) {
      log({ event: "claude_turn", step: "effort_unsupported" });
      return;
    }
    threads.changeEffort(threadId, effort);
  };

  // The runtime closes its sessions, which ends each active turn's message stream, so no Claude process outlives the bridge.
  const closeAll = () => {
    closed = true;
    appRequests.cancel(null);
    runtime.closeAll();
  };

  // A failed turn is shown to the user, who decides whether to send it again, so no turn outcome is treated as unknown here; only a crash or a thread tool write left undecided leaves the marker.
  const runTurn = async (
    request: TurnRequest,
    thread: Thread,
    threadId: string,
    input: TurnInput,
    messageId: string | null,
  ) => {
    const queued = { threadId, thread, input, messageId };
    if (store.get(threadId) === undefined) {
      const registered = await store.register({
        threadId,
        model: thread.model,
        worktree: thread.cwd,
        effort: input.effort,
      });
      if (
        registered.isErr() &&
        registered.error._tag !== "ThreadAlreadyRegistered"
      ) {
        forgetMessage(threadId, messageId);
        refuseTurn(request, queued, "thread_not_saved", registered.error);
        return;
      }
      // A turn accepted just before this one may have registered the thread first, with its own model and directory.
      const saved = threads.threadOf(threadId);
      const change =
        saved === undefined ? null : savedThreadChange(thread, saved);
      if (change !== null) {
        forgetMessage(threadId, messageId);
        refuseTurn(request, queued, change);
        return;
      }
      threads.markRegistered(threadId);
    }
    const typedByUser = input.toolOutput === null && messageId !== null;
    if (
      typedByUser &&
      refusedForUnknown.get(threadId)?.has(messageId) === false
    ) {
      const cleared = await store.resolveOutcomeUnknown(threadId);
      if (cleared.isErr()) {
        forgetMessage(threadId, messageId);
        refuseTurn(request, queued, "thread_busy", cleared.error);
        return;
      }
      refusedForUnknown.delete(threadId);
      log({ event: "claude_turn", step: "outcome_cleared" });
    }
    let responded = false;
    const ran = await store.runWrite(
      threadId,
      async (record) => {
        if (closed) {
          forgetMessage(threadId, messageId);
          refuseTurn(request, queued, "bridge_closing");
          return Result.ok();
        }
        // Claude could not answer an unsaved requester, and the message id is saved after it so a refused message may be sent again.
        const noted = await recordRequester(threadId, input.requester);
        if (noted.isErr()) {
          forgetMessage(threadId, messageId);
          refuseTurn(request, queued, "requester_not_saved", noted.error);
          return Result.ok();
        }
        // Without the saved id a restart could run the same message again, so the turn does not start.
        const saved = await recordMessage(threadId, messageId);
        if (saved.isErr()) {
          forgetMessage(threadId, messageId);
          refuseTurn(request, queued, "message_not_saved", saved.error);
          return Result.ok();
        }
        responded = true;
        materialize(threadId);
        const active: ActiveTurn<Tag> = {
          threadId,
          state: null,
          turn: null,
          link: null,
        };
        activeTurns.set(threadId, active);
        await streamTurn(
          request,
          record,
          thread.model,
          active,
          input,
          messageId,
        );
        release(active);
        const link = active.link;
        link?.stopWrites();
        if (link === null || !link.hasUnsettledWrite()) return Result.ok();
        // An undecided write stays on its link, so the session goes with it and the turn the user continues with starts on a new link.
        runtime.dropSession(threadId, link);
        return Result.err(
          new LinkWriteUnsettled({
            message: "a thread tool write has an unknown outcome",
          }),
        );
      },
      (error) => error._tag === "LinkWriteUnsettled",
    );
    if (ran.isOk()) return;
    if (ran.error._tag === "LinkWriteUnsettled") {
      log({ event: "claude_turn", step: "outcome_unknown" });
      return;
    }
    if (!responded) {
      forgetMessage(threadId, messageId);
      // Re-running could repeat a write that already landed, so the user decides by sending again after being told.
      if (ran.error._tag === "WriteOutcomeUnknown") {
        if (typedByUser) {
          const refused = refusedForUnknown.get(threadId) ?? new Set();
          refusedForUnknown.set(threadId, refused.add(messageId));
        }
        refuseTurn(request, queued, "outcome_unknown", ran.error);
        return;
      }
      refuseTurn(request, queued, "thread_busy", ran.error, ran.error.message);
      return;
    }
    log({
      event: "claude_turn",
      step: "run_state_not_saved",
      error: ran.error._tag,
    });
  };

  const materialize = (threadId: string) => {
    if (materialized.has(threadId)) return;
    materialized.add(threadId);
    void materializeThread(threadId).then((done) => {
      if (done.isOk()) return;
      materialized.delete(threadId);
      log({
        event: "claude_turn",
        step: "thread_not_materialized",
        error: done.error._tag,
      });
    });
  };

  const refuseTurn = (
    request: TurnRequest,
    {
      threadId,
      thread,
      input,
      messageId,
    }: {
      threadId: string;
      thread: Thread;
      input: TextInput;
      messageId: string | null;
    },
    reason: Refusal,
    cause: { _tag: StoreTag } | null = null,
    message: string = refusalMessage(reason),
  ) => {
    if (!request.answered) {
      refuse(request.id, reason, cause, message);
      return;
    }
    waitingTurns.delete(request.turnId);
    logRefusal(reason, cause);
    const started = renderTurnStarted({
      threadId,
      turnId: request.turnId,
      cwd: thread.cwd,
      now: now(),
    });
    const shown = renderInput(started.state, input, messageId);
    const failed = renderTurnCompleted(
      shown.state,
      { status: "failed", message },
      now(),
    );
    // The thread's status belongs to the turn running ahead of this one, if any.
    for (const notification of [
      ...started.notifications,
      ...shown.notifications,
      ...failed.notifications,
    ]) {
      if (notification.method !== "thread/status/changed") send(notification);
    }
  };

  const isDelivered = (threadId: string, messageId: string) =>
    (acceptedMessageIds.get(threadId)?.has(messageId) ?? false) ||
    (store.get(threadId)?.messageIds.includes(messageId) ?? false);

  const acceptMessage = (threadId: string, messageId: string) => {
    const ids = acceptedMessageIds.get(threadId) ?? new Set<string>();
    acceptedMessageIds.set(threadId, ids.add(messageId));
  };

  // A message refused before it ran may be sent again.
  const forgetMessage = (threadId: string, messageId: string | null) => {
    if (messageId === null) return;
    const ids = acceptedMessageIds.get(threadId);
    ids?.delete(messageId);
    if (ids?.size === 0) acceptedMessageIds.delete(threadId);
  };

  // A requester already saved is not written again, so a store that cannot be written does not refuse a thread it already knows.
  const recordRequester = async (threadId: string, requester: string | null) =>
    requester === null ||
    store.get(threadId)?.requesterThreadIds.includes(requester)
      ? Result.ok()
      : store.addRequester(threadId, requester);

  const recordMessage = async (threadId: string, messageId: string | null) => {
    if (messageId === null) return Result.ok();
    const saved = await store.addMessageId(threadId, messageId);
    if (saved.isOk()) forgetMessage(threadId, messageId);
    return saved;
  };

  const streamTurn = async (
    request: TurnRequest,
    record: ThreadRecord,
    model: string,
    active: ActiveTurn<Tag>,
    input: TurnInput,
    messageId: string | null,
  ) => {
    const threadId = record.threadId;
    const turnStartedAt = now();
    const started = renderTurnStarted({
      threadId,
      turnId: request.turnId,
      cwd: record.worktree,
      now: now(),
      compaction: request.compaction,
    });
    const turn = runningTurn(
      active,
      request,
      record,
      model,
      input,
      turnStartedAt,
      started.state,
    );
    active.turn = turn;
    apply(active, started);
    if (!request.answered)
      send({ id: request.id, result: { turn: started.turn } });
    log({ event: "claude_turn", step: "started" });
    apply(active, renderInput(started.state, input, messageId));
    waitingTurns.delete(request.turnId);
    if (request.stopped && active.state !== null) {
      active.state = markInterrupting(active.state);
    }
    await runtime.run(turn);
  };

  // opened is the state the turn started with, which the app has been shown before the runtime can read it.
  const runningTurn = (
    active: ActiveTurn<Tag>,
    request: TurnRequest,
    record: ThreadRecord,
    model: string,
    input: TurnInput,
    startedAtMs: number,
    opened: TurnState,
  ): RunningTurn<Tag> => ({
    threadId: record.threadId,
    turnId: request.turnId,
    record,
    model,
    input,
    compaction: request.compaction,
    startedAtMs,
    state: () => active.state ?? opened,
    apply: (rendered, error = null) => apply(active, rendered, error),
    finish: (outcome, error) => finish(active, outcome, error),
    fail: (error) => fail(active, error),
    isOpen: () => activeTurns.get(record.threadId) === active,
    useLink: (link) => {
      active.link = link;
    },
    ask: (method, params, signal) =>
      appRequests.ask(record.threadId, method, params, signal),
  });

  const renderInput = (
    state: TurnState,
    input: TextInput,
    messageId: string | null,
  ): Rendered => {
    const delegated =
      input.toolOutput === null
        ? { state, notifications: [] }
        : renderToolOutput(state, input.toolOutput, now());
    if (input.items.length === 0) return delegated;
    const typed = renderUserInput(
      delegated.state,
      input.items,
      messageId,
      now(),
    );
    return {
      state: typed.state,
      notifications: [...delegated.notifications, ...typed.notifications],
    };
  };

  // The app may start the next turn as soon as it sees turn/completed, so the thread stops counting as active then; the store's per-thread queue still holds that turn until this one's marker is cleared.
  const apply = (
    active: ActiveTurn<Tag>,
    rendered: Rendered,
    error: Tag | null = null,
  ) => {
    const wasFinished = active.state?.finished ?? false;
    active.state = rendered.state;
    if (rendered.state.finished) release(active);
    for (const notification of rendered.notifications) {
      send(notification);
      if (
        notification.method === "turn/completed" &&
        notification.params.turn.status !== "inProgress" &&
        !wasFinished
      ) {
        log({
          event: "claude_turn",
          step: "finished",
          status: notification.params.turn.status,
          error,
        });
      }
    }
  };

  // A turn the user already stopped ends as interrupted whatever went wrong afterwards.
  const fail = (
    active: ActiveTurn<Tag>,
    error: { _tag: Tag; message: string },
  ) =>
    finish(
      active,
      active.state?.interrupting
        ? { status: "interrupted" }
        : { status: "failed", message: error.message },
      error._tag,
    );

  const finish = (
    active: ActiveTurn<Tag>,
    outcome: TurnOutcome,
    error: Tag | null,
  ) => {
    if (active.state === null || active.state.finished) return;
    apply(active, renderTurnCompleted(active.state, outcome, now()), error);
  };

  // A prompt still open when its turn ends can no longer change what Claude did, so it is closed with the turn.
  const release = (active: ActiveTurn<Tag>) => {
    if (activeTurns.get(active.threadId) === active) {
      activeTurns.delete(active.threadId);
      appRequests.cancel(active.threadId);
    }
  };

  const refuse = (
    id: AppRequest["id"],
    reason: Refusal,
    cause: { _tag: StoreTag } | null = null,
    message: string = refusalMessage(reason),
  ) => {
    reject({ id }, message);
    logRefusal(reason, cause);
  };

  const logRefusal = (reason: Refusal, cause: { _tag: StoreTag } | null) =>
    log({
      event: "claude_turn",
      step: "refused",
      reason,
      error: cause?._tag ?? null,
    });

  // The router logs its own refusals, so this only answers the app.
  const reject = ({ id }: Pick<AppRequest, "id">, message: string) =>
    send({ id, error: { code: INVALID_REQUEST, message } });

  return {
    startTurn,
    compactThread,
    steerTurn,
    interruptTurn,
    changeModel: threads.changeModel,
    closeAll,
    reject,
    answerRequest: appRequests.answer,
    selectMode,
    modeOf: (threadId: string) => modes.get(threadId),
    selectEffort,
    effortOf: (threadId: string) => {
      const model = threads.threadOf(threadId)?.model;
      return model === undefined
        ? null
        : effortRule(model, threads.pickedEffortOf(threadId));
    },
    effortRule,
    isClaudeThread: (threadId: unknown) =>
      typeof threadId === "string" && threads.threadOf(threadId) !== undefined,
    threadOf: threads.threadOf,
    sessionIdOf: threads.sessionIdOf,
    adopt: threads.adopt,
  };
};

export const serializeTurnEvent = (entry: TurnEvent) => {
  switch (entry.step) {
    case "started":
    case "queued":
    case "outcome_unknown":
    case "steered":
    case "model_changed":
    case "outcome_cleared":
    case "effort_unsupported":
      return { event: entry.event, step: entry.step };
    case "effort_changed":
      return { event: entry.event, step: entry.step, effort: entry.effort };
    case "finished":
      return {
        event: entry.event,
        step: entry.step,
        status: entry.status,
        error: entry.error,
      };
    case "refused":
      return {
        event: entry.event,
        step: entry.step,
        reason: entry.reason,
        error: entry.error,
      };
    case "thread_not_materialized":
    case "session_not_saved":
    case "model_not_saved":
    case "effort_not_saved":
    case "run_state_not_saved":
      return { event: entry.event, step: entry.step, error: entry.error };
  }
};

// A reviewer's reply is already answerable and the thread cannot message itself, and a Claude sender is left out since Claude-to-Claude round trips are outside O2 and would raise usage.
const requesterOf = (
  threadId: string,
  source: string | null | undefined,
  owner: string | undefined,
  claudeThreadOf: (threadId: string) => Thread | undefined,
) =>
  source == null ||
  source === threadId ||
  owner !== undefined ||
  claudeThreadOf(source) !== undefined
    ? null
    : source;

const clientMessageId = (params: Record<string, unknown>) =>
  typeof params.clientUserMessageId === "string" &&
  params.clientUserMessageId !== ""
    ? params.clientUserMessageId
    : null;

const textInput = (
  value: unknown,
  delegated: { text: string; toolOutput: ToolOutput } | null,
): TextInput | null => {
  const items = Array.isArray(value) ? value : [];
  if (items.length === 0 && delegated === null) return null;
  const texts = delegated === null ? [] : [delegated.text];
  for (const item of items) {
    if (!isTextItem(item)) return null;
    texts.push(item.text);
  }
  return {
    items: items as UserInput[],
    toolOutput: delegated?.toolOutput ?? null,
    text: texts.join("\n"),
  };
};

const isTextItem = (item: unknown): item is { type: "text"; text: string } =>
  typeof item === "object" &&
  item !== null &&
  "type" in item &&
  item.type === "text" &&
  "text" in item &&
  typeof item.text === "string";

const INVALID_REQUEST = -32600;

// The model, effort and session id a thread runs with are set here before the store saves them and win over what it holds, so a failed save still applies while the bridge runs; a null session id is one Claude lost.
export const createThreadValues = (
  store: ThreadStore,
  log: (event: ThreadValueEvent) => void,
) => {
  // Threads created with a Claude model are saved to the store only on their first turn, so a thread never used leaves nothing behind.
  const adopted = new Map<string, Thread>();
  const models = new Map<string, string>();
  const efforts = new Map<string, EffortLevel>();
  const sessionIds = new Map<string, string | null>();

  const threadOf = (threadId: string): Thread | undefined => {
    const record = store.get(threadId);
    const thread =
      record === undefined
        ? adopted.get(threadId)
        : { model: record.model, cwd: record.worktree };
    const model = models.get(threadId);
    return thread === undefined || model === undefined
      ? thread
      : { ...thread, model };
  };

  // A saved level that is no Claude level, such as one written by hand, leaves Claude on the user's settings.
  const pickedEffortOf = (threadId: string): EffortLevel | null => {
    const effort = efforts.get(threadId) ?? store.get(threadId)?.effort;
    return isClaudeEffort(effort) ? effort : null;
  };

  const sessionIdOf = (threadId: string) =>
    sessionIds.has(threadId)
      ? (sessionIds.get(threadId) ?? null)
      : (store.get(threadId)?.sessionId ?? null);

  const adopt = (threadId: string, thread: Thread) => {
    if (store.get(threadId) === undefined) adopted.set(threadId, thread);
  };

  // A model or effort picked while the thread was being registered is saved now, since the registration carried the earlier one.
  const markRegistered = (threadId: string) => {
    adopted.delete(threadId);
    const picked = models.get(threadId);
    if (picked !== undefined && picked !== store.get(threadId)?.model) {
      saveModel(threadId, picked);
    }
    const effort = efforts.get(threadId);
    if (effort !== undefined && effort !== store.get(threadId)?.effort) {
      saveEffort(threadId, effort);
    }
  };

  // A running turn keeps its model; the next turn restarts Claude on the new one and resumes the same conversation.
  const changeModel = (threadId: string, model: string) => {
    const thread = threadOf(threadId);
    if (thread === undefined || thread.model === model) return;
    models.set(threadId, model);
    log({ event: "claude_turn", step: "model_changed" });
    // A thread not yet registered saves this model when its first turn registers it.
    if (store.get(threadId) !== undefined) saveModel(threadId, model);
  };

  // A Codex thread switched to Claude by a turn/start is not known yet, and that turn registers it with this effort.
  const changeEffort = (threadId: string, effort: EffortLevel) => {
    if (pickedEffortOf(threadId) === effort) return;
    efforts.set(threadId, effort);
    log({ event: "claude_turn", step: "effort_changed", effort });
    if (store.get(threadId) !== undefined) saveEffort(threadId, effort);
  };

  const setSessionId = async (threadId: string, sessionId: string | null) => {
    sessionIds.set(threadId, sessionId);
    const saved = await store.setSessionId(threadId, sessionId);
    if (saved.isErr()) {
      log({
        event: "claude_turn",
        step: "session_not_saved",
        error: saved.error._tag,
      });
    }
  };

  const saveModel = (threadId: string, model: string) => {
    void store.setModel(threadId, model).then((saved) => {
      if (saved.isErr()) {
        log({
          event: "claude_turn",
          step: "model_not_saved",
          error: saved.error._tag,
        });
      }
    });
  };

  const saveEffort = (threadId: string, effort: EffortLevel) => {
    void store.setEffort(threadId, effort).then((saved) => {
      if (saved.isErr()) {
        log({
          event: "claude_turn",
          step: "effort_not_saved",
          error: saved.error._tag,
        });
      }
    });
  };

  return {
    threadOf,
    pickedEffortOf,
    sessionIdOf,
    adopt,
    markRegistered,
    changeModel,
    changeEffort,
    setSessionId,
  };
};

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
  | { event: "claude_turn"; step: "interrupt_failed"; error: InterruptTag };

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
type ClaudeTurn = {
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
    const claude: ClaudeTurn = {
      slot: null,
      unsentSteers: [],
      pendingSteers: new Set(),
      steers: 0,
    };
    turns.set(turn, claude);
    runningTurns.set(turn.threadId, turn);
    await stream(turn, claude);
    if (runningTurns.get(turn.threadId) === turn) {
      runningTurns.delete(turn.threadId);
    }
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
    case "interrupt_failed":
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
  const taken =
    listed ??
    (result.user_message_uuid === undefined ? [] : [result.user_message_uuid]);
  for (const uuid of taken) pendingSteers.delete(uuid);
  if (interrupting) return "none";
  if (result.subtype !== "success" || result.is_error) return "none";
  if (pendingSteers.size === 0) return "none";
  const complete = listed !== undefined && listed.length < TAKEN_UUIDS_LIMIT;
  return complete || (result.queued_turn_count ?? 0) > 0 ? "queued" : "unknown";
};

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
