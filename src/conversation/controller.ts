import { randomUUID } from "node:crypto";
import { matchError, Result, TaggedError } from "better-result";
import type { ImageSource } from "../infra/claude/images.ts";
import { createAppRequests } from "../infra/codex/app-requests.ts";
import { delegatedMessage } from "../infra/codex/delegations.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import { isManualTurnTrigger } from "../infra/codex/turn-trigger.ts";
import type { ThreadRecord, ThreadStore } from "../infra/thread-store.ts";
import type { LiveTurn } from "../presentation/history.ts";
import type { UserInput } from "../presentation/protocol.ts";
import { RECOVERY_NOTICE } from "../presentation/recovery.ts";
import {
  markInterrupting,
  type Rendered,
  renderNotice,
  renderToolOutput,
  renderTurnCompleted,
  renderTurnStarted,
  renderUserInput,
  steeredTurn,
  type TurnOutcome,
  type TurnState,
} from "../presentation/turn.ts";
import { isObject } from "../runtime/object.ts";
import {
  type AppRequest,
  checkThread,
  type Refusal,
  refusalMessage,
  requestedEffort,
  requestedMode,
  savedThreadChange,
  type Thread,
} from "./thread-request.ts";
import type {
  StoreTag,
  ThreadValueEvent,
  ThreadValues,
} from "./thread-values.ts";
import type {
  ErrorTag,
  MessageInput,
  RunningTurn,
  ThreadEnd,
  ToolOutput,
  TurnInput,
  TurnLink,
  TurnRuntime,
} from "./turn-runtime.ts";

// Only steps, turn statuses, models, effort levels, token counts, durations, refusal reasons and error tags are logged, never thread ids or text.
export type TurnEvent<
  // The failure tags a runtime declares, so only a tag written in code can reach the log as a turn's error.
  Tag extends string = string,
> =
  | ThreadValueEvent
  | {
      event: "claude_turn";
      step:
        | "started"
        | "queued"
        | "outcome_unknown"
        | "steered"
        | "outcome_cleared";
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
  | { event: "claude_turn"; step: "run_state_not_saved"; error: StoreTag }
  | {
      event: "claude_turn";
      step: "thread_released";
      ended: ThreadEnd;
      kept: boolean;
    };

type MaterializeThread = (
  threadId: string,
) => Promise<Result<unknown, { _tag: ErrorTag<ReturnType<ServerRequest>> }>>;

type ActiveTurn<Tag extends string> = {
  threadId: string;
  state: TurnState;
  turn: RunningTurn<Tag>;
  link: TurnLink | null;
  outcomeUnknown: boolean;
};

// answered is set when the app got the turn as soon as it was accepted, so a turn that cannot run is shown as failed rather than refused; a turn Claude started on its own answers no request.
type TurnRequest = {
  id: AppRequest["id"] | null;
  turnId: string;
  answered: boolean;
  stopped: boolean;
  compaction: boolean;
  allowRecovery: boolean;
};

class TurnOutcomeUnknown extends TaggedError("TurnOutcomeUnknown")<{
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
}: {
  store: ThreadStore;
  threads: ThreadValues;
  runtime: TurnRuntime<Tag>;
  materializeThread: MaterializeThread;
  send: (message: object) => void;
  log: (event: TurnEvent<Tag>) => void;
  now?: () => number;
  newTurnId?: () => string;
}) => {
  const activeTurns = new Map<string, ActiveTurn<Tag>>();
  // Message ids accepted but not yet saved, so a copy arriving while the first waits or runs is caught too.
  const acceptedMessageIds = new Map<string, Set<string>>();
  const turnsInFlight = new Map<string, number>();
  const materialized = new Set<string>();
  const changingConversations = new Set<string>();
  const startingTurns = new Map<
    string,
    { threadId: string; acceptedAtMs: number }
  >();
  const waitingTurns = new Map<
    string,
    { threadId: string; request: TurnRequest }
  >();
  const steeringMessages = new Map<string, Promise<void>>();
  const appRequests = createAppRequests({ send, now });
  let closed = false;

  const startTurn = (
    { id, params }: AppRequest,
    fallbackCwd: string | undefined,
  ): Refusal | null => {
    const threadId = params.threadId;
    if (typeof threadId === "string" && changingConversations.has(threadId)) {
      return refuse(id, "thread_busy");
    }
    if (typeof threadId !== "string") {
      return refuse(id, "missing_thread");
    }
    const checked = checkThread(
      params,
      threads.threadOf(threadId),
      fallbackCwd,
    );
    if (checked.isErr()) {
      return refuse(id, checked.error.refusal);
    }
    const delegated = delegatedMessage(params);
    const input = messageInput(params.input, delegated);
    if (typeof input === "string") {
      return refuse(id, input);
    }
    if (closed) {
      return refuse(id, "bridge_closing");
    }
    const messageId = clientMessageId(params);
    if (messageId !== null && isDelivered(threadId, messageId)) {
      return refuse(id, "duplicate_message");
    }
    if (messageId !== null) acceptMessage(threadId, messageId);
    threads.changeModel(threadId, checked.value.model);
    const effort = requestedEffort(params);
    if (effort !== undefined) threads.selectEffort(threadId, effort);
    const turn = {
      ...input,
      permissionMode: threads.selectMode(
        threadId,
        requestedMode(params) ?? threads.modeOf(threadId) ?? "default",
      ),
      effort: threads.pickedEffortOf(threadId),
      startedBy: "app" as const,
    };
    // The app gives another thread's message no id to deliver again, so one with an id stays on the turn path, which saves the id before the message runs.
    if (
      delegated !== null &&
      messageId === null &&
      (steerableTurn(threadId) !== null || steeringMessages.has(threadId))
    ) {
      steerMessage(id, threadId, checked.value, turn);
      return null;
    }
    const allowRecovery =
      delegated === null &&
      messageId !== null &&
      isManualTurnTrigger(params.turnTrigger);
    afterSteers(threadId, () =>
      acceptTurn(
        id,
        threadId,
        checked.value,
        turn,
        messageId,
        false,
        allowRecovery,
      ),
    );
    return null;
  };

  const compactThread = ({ id, params }: AppRequest) => {
    const threadId = params.threadId;
    if (typeof threadId !== "string") {
      refuse(id, "missing_thread");
      return;
    }
    const checked = checkThread(params, threads.threadOf(threadId), undefined);
    if (checked.isErr()) {
      refuse(id, checked.error.refusal);
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
      images: [],
      permissionMode: threads.modeOf(threadId) ?? "default",
      effort: threads.pickedEffortOf(threadId),
      startedBy: "app" as const,
    };
    afterSteers(threadId, () =>
      acceptTurn(id, threadId, checked.value, turn, null, true),
    );
  };

  const startOwnTurn = (threadId: string) => {
    const thread = threads.threadOf(threadId);
    if (thread === undefined || closed || changingConversations.has(threadId))
      return false;
    const turn: TurnInput = {
      items: [],
      toolOutput: null,
      text: "",
      images: [],
      permissionMode: threads.modeOf(threadId) ?? "default",
      effort: threads.pickedEffortOf(threadId),
      startedBy: "claude",
    };
    // The runtime is told at once whether the turn will be shown, so it does not wait for messages being steered.
    acceptTurn(null, threadId, thread, turn, null, false);
    return true;
  };
  runtime.listen(startOwnTurn);

  const acceptTurn = (
    id: AppRequest["id"] | null,
    threadId: string,
    thread: Thread,
    turn: TurnInput,
    messageId: string | null,
    compaction: boolean,
    allowRecovery = false,
  ) => {
    if (changingConversations.has(threadId)) {
      if (id !== null) refuse(id, "thread_busy");
      forgetMessage(threadId, messageId);
      return;
    }
    runtime.threadBusy(threadId);
    const inFlight = turnsInFlight.get(threadId) ?? 0;
    if (inFlight > 0) log({ event: "claude_turn", step: "queued" });
    turnsInFlight.set(threadId, inFlight + 1);
    const request = {
      id,
      turnId: newTurnId(),
      // A turn/start that waits behind a running turn is answered on acceptance, since its sender gives up long before the running turn may end.
      answered: compaction || inFlight > 0 || id === null,
      stopped: false,
      compaction,
      allowRecovery,
    };
    if (inFlight > 0) waitingTurns.set(request.turnId, { threadId, request });
    startingTurns.set(request.turnId, { threadId, acceptedAtMs: now() });
    if (compaction) {
      send({ id, result: {} });
    } else if (request.answered && id !== null) {
      const waiting = renderTurnStarted({
        threadId,
        turnId: request.turnId,
        cwd: thread.cwd,
        now: now(),
      });
      send({ id, result: { turn: waiting.turn } });
    }
    void runTurn(request, thread, threadId, turn, messageId).then(() => {
      startingTurns.delete(request.turnId);
      const left = (turnsInFlight.get(threadId) ?? 1) - 1;
      if (left > 0) {
        turnsInFlight.set(threadId, left);
        return;
      }
      turnsInFlight.delete(threadId);
      runtime.threadIdle(threadId);
    });
  };

  const steerableTurn = (threadId: string) => {
    const active = activeTurns.get(threadId);
    // A turn already waiting behind the running one would run after a message that came later, so the message waits too; a compaction or a turn being stopped takes no steer.
    return active === undefined ||
      active.state.finished ||
      active.state.interrupting ||
      active.state.compaction ||
      turnsInFlight.get(threadId) !== 1
      ? null
      : active;
  };

  const steerMessage = (
    id: AppRequest["id"],
    threadId: string,
    thread: Thread,
    input: TurnInput,
  ) =>
    afterSteers(threadId, async () => {
      const active = steerableTurn(threadId);
      if (active === null) {
        acceptTurn(id, threadId, thread, input, null, false);
        return;
      }
      if (closed) {
        refuse(id, "bridge_closing");
        return;
      }
      const refusal = await runtime.steer(active.turn, input);
      if (refusal !== null) {
        acceptTurn(id, threadId, thread, input, null, false);
        return;
      }
      send({ id, result: { turn: steeredTurn(active.state) } });
      log({ event: "claude_turn", step: "steered" });
      apply(active, renderInput(active.state, input, null));
    });

  const afterSteers = (threadId: string, run: () => void | Promise<void>) => {
    const ahead = steeringMessages.get(threadId);
    // A message still being steered may yet run as a turn, so a later turn/start or compaction is accepted only once it is done, keeping the order they came in.
    const steering = ahead === undefined ? run() : ahead.then(run);
    if (steering === undefined) return;
    steeringMessages.set(threadId, steering);
    void steering.then(() => {
      if (steeringMessages.get(threadId) === steering)
        steeringMessages.delete(threadId);
    });
  };

  const steerTurn = async ({ id, params }: AppRequest) => {
    const active = activeTurns.get(String(params.threadId));
    if (
      active === undefined ||
      active.state.finished ||
      active.state.interrupting ||
      active.state.turnId !== params.expectedTurnId
    ) {
      refuse(id, "no_running_turn");
      return;
    }
    const state = active.state;
    // Codex also takes no steer into a compaction, whose prompt Claude runs as a command rather than a conversation turn.
    if (state.compaction) {
      refuse(id, "compaction_not_steerable");
      return;
    }
    const input = messageInput(params.input, null);
    if (typeof input === "string") {
      refuse(id, input);
      return;
    }
    // Claude takes a steer at its next tool boundary, or as its next turn once the running one ends; the app turn stays open until then.
    const refusal = await runtime.steer(active.turn, input);
    if (refusal !== null) {
      refuse(id, refusal);
      return;
    }
    send({ id, result: { turnId: state.turnId } });
    log({ event: "claude_turn", step: "steered" });
    apply(active, renderUserInput(active.state, input.items, null, now()));
  };

  const interruptTurn = ({ id, params }: AppRequest) => {
    const threadId = String(params.threadId);
    const active = activeTurns.get(threadId);
    if (
      active === undefined ||
      active.state.finished ||
      active.state.turnId !== params.turnId
    ) {
      stopWaitingTurn(id, threadId, params.turnId);
      return;
    }
    // A stop while the session already has an interrupt in flight, from this turn or an earlier one, is answered without asking Claude again; that interrupt decides the session, and a turn that has not sent yet stops before sending.
    const repeated = active.state.interrupting;
    active.state = markInterrupting(active.state);
    // The reply comes first so the app sees it before the interrupted turn completes.
    send({ id, result: {} });
    appRequests.cancel(threadId);
    runtime.interrupt(active.turn, repeated);
  };

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
    // The running turn's prompts are left open, since the stop is for a turn behind it.
    waiting.request.stopped = true;
    send({ id, result: {} });
  };

  const closeAll = () => {
    closed = true;
    appRequests.cancel(null);
    runtime.closeAll();
  };

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
    let responded = false;
    const ran = await store.runWrite(
      threadId,
      async (record, recovered) => {
        if (closed) {
          forgetMessage(threadId, messageId);
          refuseTurn(request, queued, "bridge_closing");
          return recovered
            ? Result.err(
                new TurnOutcomeUnknown({
                  message: "the bridge closed before recovery started",
                }),
              )
            : Result.ok();
        }
        // Without the saved id a restart could run the same message again, so the turn does not start.
        const saved = await recordMessage(threadId, messageId);
        if (saved.isErr()) {
          forgetMessage(threadId, messageId);
          refuseTurn(request, queued, "message_not_saved", saved.error);
          return recovered
            ? Result.err(
                new TurnOutcomeUnknown({
                  message: "the message could not be saved before recovery",
                }),
              )
            : Result.ok();
        }
        responded = true;
        if (recovered) log({ event: "claude_turn", step: "outcome_cleared" });
        materialize(threadId);
        const active = await streamTurn(
          request,
          record,
          thread.model,
          input,
          messageId,
          recovered,
        );
        release(active);
        const link = active.link;
        link?.stopWrites();
        if (active.outcomeUnknown) {
          if (link !== null) runtime.dropSession(threadId, link);
          return Result.err(
            new TurnOutcomeUnknown({
              message: "the turn could not save its Claude conversation",
            }),
          );
        }
        if (recovered && runtime.recordOf(threadId, request.turnId) === null)
          return Result.err(
            new TurnOutcomeUnknown({
              message: "the recovery prompt was not sent to Claude",
            }),
          );
        if (link === null || !link.hasUnsettledWrite()) return Result.ok();
        // An undecided write stays on its link, so the session goes with it and the turn the user continues with starts on a new link.
        runtime.dropSession(threadId, link);
        return Result.err(
          new TurnOutcomeUnknown({
            message: "a thread tool write has an unknown outcome",
          }),
        );
      },
      (error) => error._tag === "TurnOutcomeUnknown",
      () => request.allowRecovery && !closed && !request.stopped,
    );
    if (ran.isOk()) return;
    const notRun = (error: { _tag: StoreTag; message: string }) => {
      if (responded) {
        log({
          event: "claude_turn",
          step: "run_state_not_saved",
          error: error._tag,
        });
        return;
      }
      forgetMessage(threadId, messageId);
      refuseTurn(request, queued, "thread_busy", error, error.message);
    };
    matchError(ran.error, {
      TurnOutcomeUnknown: () =>
        log({ event: "claude_turn", step: "outcome_unknown" }),
      PreviousWriteUnsettled: (error) => {
        if (responded) return notRun(error);
        forgetMessage(threadId, messageId);
        refuseTurn(request, queued, "outcome_unknown", error);
      },
      ThreadNotFound: notRun,
      WriteNotStarted: notRun,
      RunStateNotSaved: notRun,
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
      input: MessageInput;
      messageId: string | null;
    },
    reason: Refusal,
    cause: { _tag: StoreTag } | null = null,
    message: string = refusalMessage(reason),
  ) => {
    if (!request.answered && request.id !== null) {
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

  const forgetMessage = (threadId: string, messageId: string | null) => {
    if (messageId === null) return;
    const ids = acceptedMessageIds.get(threadId);
    ids?.delete(messageId);
    if (ids?.size === 0) acceptedMessageIds.delete(threadId);
  };

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
    input: TurnInput,
    messageId: string | null,
    recovered = false,
  ): Promise<ActiveTurn<Tag>> => {
    const threadId = record.threadId;
    const turnStartedAt = now();
    const started = renderTurnStarted({
      threadId,
      turnId: request.turnId,
      cwd: record.worktree,
      now: now(),
      compactionRequested: request.compaction,
    });
    const active = activeTurn(
      request,
      record,
      model,
      input,
      turnStartedAt,
      started.state,
    );
    active.turn.recovering = recovered;
    activeTurns.set(threadId, active);
    apply(active, started);
    if (!request.answered)
      send({ id: request.id, result: { turn: started.turn } });
    log({ event: "claude_turn", step: "started" });
    apply(active, renderInput(started.state, input, messageId));
    if (recovered)
      apply(
        active,
        renderNotice(active.state, RECOVERY_NOTICE, "commentary", now()),
      );
    waitingTurns.delete(request.turnId);
    startingTurns.delete(request.turnId);
    if (request.stopped) {
      active.state = markInterrupting(active.state);
    }
    await runtime.run(active.turn);
    return active;
  };

  const activeTurn = (
    request: TurnRequest,
    record: ThreadRecord,
    model: string,
    input: TurnInput,
    startedAtMs: number,
    state: TurnState,
  ): ActiveTurn<Tag> => {
    const turn: RunningTurn<Tag> = {
      threadId: record.threadId,
      turnId: request.turnId,
      record,
      model,
      input,
      compaction: request.compaction,
      startedAtMs,
      state: () => active.state,
      apply: (rendered, error = null) => apply(active, rendered, error),
      finish: (outcome, error) => finish(active, outcome, error),
      fail: (error) => fail(active, error),
      markOutcomeUnknown: () => {
        active.outcomeUnknown = true;
      },
      isOpen: () => activeTurns.get(record.threadId) === active,
      useLink: (link) => {
        active.link = link;
      },
      ask: (method, params, signal) =>
        appRequests.ask(record.threadId, method, params, signal),
    };
    const active: ActiveTurn<Tag> = {
      threadId: record.threadId,
      state,
      turn,
      link: null,
      outcomeUnknown: false,
    };
    return active;
  };

  const renderInput = (
    state: TurnState,
    input: MessageInput,
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

  const apply = (
    active: ActiveTurn<Tag>,
    rendered: Rendered,
    error: Tag | null = null,
  ) => {
    const wasFinished = active.state.finished;
    active.state = rendered.state;
    // The app may start the next turn as soon as it sees turn/completed, so the thread stops counting as active then; the store's per-thread queue still holds that turn until this one's marker is cleared.
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

  const fail = (
    active: ActiveTurn<Tag>,
    error: { _tag: Tag; message: string },
  ) =>
    finish(
      active,
      active.state.interrupting
        ? { status: "interrupted" }
        : { status: "failed", message: error.message },
      error._tag,
    );

  const finish = (
    active: ActiveTurn<Tag>,
    outcome: TurnOutcome,
    error: Tag | null,
  ) => {
    if (active.state.finished) return;
    apply(active, renderTurnCompleted(active.state, outcome, now()), error);
  };

  const release = (active: ActiveTurn<Tag>) => {
    if (activeTurns.get(active.threadId) === active) {
      activeTurns.delete(active.threadId);
      // A prompt still open when its turn ends can no longer change what Claude did, so it is closed with the turn.
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
    return reason;
  };

  const logRefusal = (reason: Refusal, cause: { _tag: StoreTag } | null) =>
    log({
      event: "claude_turn",
      step: "refused",
      reason,
      error: cause?._tag ?? null,
    });

  const reject = ({ id }: Pick<AppRequest, "id">, message: string) =>
    // The router logs its own refusals, so this only answers the app.
    send({ id, error: { code: INVALID_REQUEST, message } });

  const changeConversation = async <T>(
    threadId: string,
    change: () => Promise<T>,
  ): Promise<T | null> => {
    if (
      closed ||
      changingConversations.has(threadId) ||
      (turnsInFlight.get(threadId) ?? 0) > 0
    )
      return null;
    changingConversations.add(threadId);
    const resume = runtime.pauseMessages(threadId);
    try {
      return await change();
    } finally {
      changingConversations.delete(threadId);
      resume();
    }
  };

  return {
    changeConversation,
    startTurn,
    compactThread,
    steerTurn,
    interruptTurn,
    closeAll,
    reject,
    answerRequest: appRequests.answer,
    liveTurnOf: (threadId: string): LiveTurn | null => {
      const active = activeTurns.get(threadId);
      if (active !== undefined && !active.state.finished) {
        const { turnId, startedAtMs } = active.state;
        return {
          turnId,
          record: runtime.recordOf(threadId, turnId),
          startedAtMs,
        };
      }
      // A turn accepted but not yet started keeps the thread running between one turn's end and the next one's start.
      for (const [turnId, starting] of startingTurns) {
        if (starting.threadId === threadId) {
          return { turnId, record: null, startedAtMs: starting.acceptedAtMs };
        }
      }
      return null;
    },
    adoptFork: (threadId: string, thread: Thread, sourceId: string) => {
      threads.adoptFork(threadId, thread, sourceId);
      return runtime.noteFork(threadId);
    },
    claudeBegun: (threadId: string) =>
      // A saved thread, a Claude conversation or a turn on its way means Claude already holds part of the thread.
      store.get(threadId) !== undefined ||
      threads.sessionIdOf(threadId) !== null ||
      turnsInFlight.has(threadId),
    dropFork: (threadId: string) => {
      threads.forgetFork(threadId);
      runtime.dropFork(threadId);
    },
    // Called once the server answered that it archived or deleted the thread.
    releaseThread: (threadId: string, ended: ThreadEnd) => {
      // A thread with a turn or an app request in progress keeps its state, since that work still uses it.
      const kept =
        turnsInFlight.has(threadId) ||
        activeTurns.has(threadId) ||
        changingConversations.has(threadId) ||
        steeringMessages.has(threadId);
      if (!kept) {
        runtime.forgetThread(threadId, ended);
        threads.forgetThread(threadId, ended);
      }
      log({ event: "claude_turn", step: "thread_released", ended, kept });
    },
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
    case "session_picked":
      return { event: entry.event, step: entry.step, thread: entry.thread };
    case "thread_not_materialized":
    case "session_not_saved":
    case "model_not_saved":
    case "effort_not_saved":
    case "run_state_not_saved":
      return { event: entry.event, step: entry.step, error: entry.error };
    case "thread_released":
      return {
        event: entry.event,
        step: entry.step,
        ended: entry.ended,
        kept: entry.kept,
      };
  }
};

const clientMessageId = (params: Record<string, unknown>) =>
  typeof params.clientUserMessageId === "string" &&
  params.clientUserMessageId !== ""
    ? params.clientUserMessageId
    : null;

const messageInput = (
  value: unknown,
  delegated: { text: string; toolOutput: ToolOutput } | null,
): MessageInput | Refusal => {
  const items = Array.isArray(value) ? value : [];
  if (items.length === 0 && delegated === null) return "unsupported_input";
  const texts = delegated === null ? [] : [delegated.text];
  const images: ImageSource[] = [];
  for (const item of items) {
    if (!isObject(item)) return "unsupported_input";
    if (item.type === "text" && typeof item.text === "string") {
      texts.push(item.text);
    } else if (item.type === "localImage" && typeof item.path === "string") {
      images.push({ path: item.path });
    } else if (item.type === "image") {
      // The app names a pasted or picked image by the file it saved; an image held only by a server, such as a URL or an uploaded file id, cannot be read here.
      if (typeof item.url !== "string" || !item.url.startsWith("data:")) {
        return "image_not_local";
      }
      images.push({ dataUrl: item.url });
    } else {
      return "unsupported_input";
    }
  }
  return {
    items: items as UserInput[],
    toolOutput: delegated?.toolOutput ?? null,
    text: texts.join("\n"),
    images,
  };
};

const INVALID_REQUEST = -32600;
