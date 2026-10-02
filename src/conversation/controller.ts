import { randomUUID } from "node:crypto";
import { Result, TaggedError } from "better-result";
import { type EffortRule, isClaudeEffort } from "../infra/claude/models.ts";
import { createAppRequests } from "../infra/codex/app-requests.ts";
import { delegatedMessage } from "../infra/codex/delegations.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import type { ThreadRecord, ThreadStore } from "../infra/thread-store.ts";
import type { UserInput } from "../presentation/protocol.ts";
import {
  markInterrupting,
  type Rendered,
  renderToolOutput,
  renderTurnCompleted,
  renderTurnStarted,
  renderUserInput,
  type TurnOutcome,
  type TurnState,
} from "../presentation/turn.ts";
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
import type {
  StoreTag,
  ThreadValueEvent,
  ThreadValues,
} from "./thread-values.ts";
import type {
  ErrorTag,
  RunningTurn,
  TextInput,
  ToolOutput,
  TurnInput,
  TurnLink,
  TurnRuntime,
} from "./turn-runtime.ts";

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

type MaterializeThread = (
  threadId: string,
) => Promise<Result<unknown, { _tag: ErrorTag<ReturnType<ServerRequest>> }>>;

// turn is set once the turn is shown to the app as started, and link by the runtime once its session is up.
type ActiveTurn<Tag extends string> = {
  threadId: string;
  state: TurnState | null;
  turn: RunningTurn<Tag> | null;
  link: TurnLink | null;
};

// answered is set when the app got the turn as soon as it was accepted, so a turn that cannot run is shown as failed rather than refused; a turn Claude started on its own answers no request.
type TurnRequest = {
  id: AppRequest["id"] | null;
  turnId: string;
  answered: boolean;
  stopped: boolean;
  compaction: boolean;
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
      startedBy: "app" as const,
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
      startedBy: "app" as const,
    };
    acceptTurn(id, threadId, checked.thread, turn, null, true);
  };

  // Claude starts turns of its own, such as when a background task reports back, and the app is shown each as a turn nobody typed, behind any turn already accepted.
  const startOwnTurn = (threadId: string) => {
    const thread = threads.threadOf(threadId);
    if (thread === undefined || closed) return false;
    const turn: TurnInput = {
      items: [],
      toolOutput: null,
      text: "",
      permissionMode: modes.get(threadId) ?? "default",
      effort: threads.pickedEffortOf(threadId),
      requester: null,
      startedBy: "claude",
    };
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
  ) => {
    runtime.threadBusy(threadId);
    const inFlight = turnsInFlight.get(threadId) ?? 0;
    if (inFlight > 0) log({ event: "claude_turn", step: "queued" });
    turnsInFlight.set(threadId, inFlight + 1);
    const request = {
      id,
      turnId: newTurnId(),
      answered: compaction || inFlight > 0 || id === null,
      stopped: false,
      compaction,
    };
    if (inFlight > 0) waitingTurns.set(request.turnId, { threadId, request });
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
    adoptFork: threads.adoptFork,
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
