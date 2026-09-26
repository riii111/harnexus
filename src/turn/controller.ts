import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  PermissionMode,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type InferErr,
  type InferOk,
  Result,
  TaggedError,
} from "better-result";
import { promptFor } from "../claude/permission.ts";
import type {
  ClaudeSessionSettings,
  startClaudeSession,
} from "../claude/session.ts";
import { delegatedMessage } from "../link/delegations.ts";
import type { createCodexLink } from "../mcp/codex-link.ts";
import type { UserInput } from "../render/protocol.ts";
import {
  markInterrupting,
  markToolDeclined,
  type Rendered,
  renderInterimResult,
  renderSdkMessage,
  renderToolRequest,
  renderTurnCompleted,
  renderTurnStarted,
  renderUserInput,
  runningToolItem,
  type TurnOutcome,
  type TurnState,
} from "../render/turn.ts";
import type { ThreadRecord, ThreadStore } from "../state/thread-store.ts";
import { createAppRequests } from "./app-requests.ts";
import {
  type AppRequest,
  checkThread,
  type Mode,
  type Refusal,
  refusalMessage,
  requestedMode,
  savedThreadChange,
  type Thread,
} from "./thread-request.ts";

// Only steps, turn statuses, refusal reasons and error tags are logged, never thread ids or text.
export type TurnEvent =
  | {
      event: "claude_turn";
      step:
        | "started"
        | "queued"
        | "outcome_unknown"
        | "steered"
        | "model_changed"
        | "idle_closed";
    }
  | {
      event: "claude_turn";
      step: "finished";
      status: TurnOutcome["status"];
      error: FailureTag | null;
    }
  | {
      event: "claude_turn";
      step: "refused";
      reason: Refusal;
      error: StoreTag | null;
    }
  | { event: "claude_turn"; step: "interrupt_failed"; error: InterruptTag }
  | {
      event: "claude_turn";
      step: "session_not_saved" | "model_not_saved" | "run_state_not_saved";
      error: StoreTag;
    };

type SessionStart = Awaited<ReturnType<typeof startClaudeSession>>;

type ClaudeSession = InferOk<SessionStart>;

type StartSession = (settings: ClaudeSessionSettings) => Promise<SessionStart>;

type CodexLink = Pick<
  ReturnType<typeof createCodexLink>,
  | "server"
  | "allowedTools"
  | "hasUnsettledWrite"
  | "stopWrites"
  | "acceptWrites"
>;

type ErrorTag<R> = InferErr<Awaited<R>> extends { _tag: infer T } ? T : never;

type StreamedMessage =
  ClaudeSession["messages"] extends AsyncGenerator<infer R> ? R : never;

type InterruptTag = ErrorTag<ReturnType<ClaudeSession["interrupt"]>>;

type FailureTag =
  | ErrorTag<SessionStart>
  | ErrorTag<ReturnType<ClaudeSession["send"]>>
  | ErrorTag<ReturnType<ClaudeSession["setPermissionMode"]>>
  | InferErr<StreamedMessage>["_tag"]
  | InterruptTag
  | BridgeClosing["_tag"]
  | StreamEnded["_tag"]
  | "SteerUnconfirmed";

// runWrite is generic in the operation's error, so the store's own tags are listed; a new tag there fails to compile here.
type StoreTag =
  | ErrorTag<ReturnType<ThreadStore["register"]>>
  | ErrorTag<ReturnType<ThreadStore["setSessionId"]>>
  | ErrorTag<ReturnType<ThreadStore["addMessageId"]>>
  | ErrorTag<ReturnType<ThreadStore["setModel"]>>
  | "ThreadNotFound"
  | "WriteOutcomeUnknown"
  | "WriteNotStarted"
  | "RunStateNotSaved";

// A session is not reused until its interrupt reports whether a send is still queued, which can arrive after the interrupted turn has ended.
type SessionSlot = {
  session: ClaudeSession;
  model: string;
  pendingInterrupt: Promise<void> | null;
  link: CodexLink;
};

// link is the thread tool server of the session the turn ran on, read when the turn ends to see whether a write was left undecided.
// Steers wait in unsentSteers until the turn's own prompt reaches Claude, then stay in pendingSteers until a result names them as taken.
type ActiveTurn = {
  threadId: string;
  state: TurnState | null;
  link: CodexLink | null;
  slot: SessionSlot | null;
  unsentSteers: string[];
  pendingSteers: Set<string>;
  steers: number;
};

// answered is set when the app got the turn as soon as it was accepted, so a turn that cannot run is shown as failed rather than refused.
type TurnRequest = { id: AppRequest["id"]; turnId: string; answered: boolean };

type TextInput = { items: UserInput[]; text: string };

type TurnInput = TextInput & { permissionMode: PermissionMode };

class BridgeClosing extends TaggedError("BridgeClosing")<{
  message: string;
}> {}

class StreamEnded extends TaggedError("StreamEnded")<{
  message: string;
}> {}

class LinkWriteUnsettled extends TaggedError("LinkWriteUnsettled")<{
  message: string;
}> {}

// A thread keeps one Claude session across turns; a session that fails is dropped and the next turn resumes it from the stored session id.
export const createTurnController = ({
  store,
  startSession,
  openLink,
  send,
  log,
  now = Date.now,
  newTurnId = () => `harnexus-turn-${randomUUID()}`,
  idleSessionMs = IDLE_SESSION_MS,
}: {
  store: ThreadStore;
  startSession: StartSession;
  openLink: (threadId: string) => CodexLink;
  send: (message: object) => void;
  log: (event: TurnEvent) => void;
  now?: () => number;
  newTurnId?: () => string;
  idleSessionMs?: number;
}) => {
  // Threads created with a Claude model are saved to the store only on their first turn, so a thread never used leaves nothing behind.
  const adopted = new Map<string, Thread>();
  const sessions = new Map<string, SessionSlot>();
  const activeTurns = new Map<string, ActiveTurn>();
  // A session id or model the store failed to save still applies while the bridge runs.
  const sessionIds = new Map<string, string>();
  const models = new Map<string, string>();
  // Message ids accepted but not yet saved, so a copy arriving while the first waits or runs is caught too.
  const acceptedMessageIds = new Map<string, Set<string>>();
  const turnsInFlight = new Map<string, number>();
  // The server keeps a Claude thread in its default mode, so the mode the app picked is remembered here.
  const modes = new Map<string, Mode>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    const checked = checkThread(params, threadOf(threadId), fallbackCwd);
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
    const input = textInput(params.input, delegated?.text ?? null);
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
    changeModel(threadId, checked.thread.model);
    cancelIdleClose(threadId);
    const inFlight = turnsInFlight.get(threadId) ?? 0;
    if (inFlight > 0) log({ event: "claude_turn", step: "queued" });
    turnsInFlight.set(threadId, inFlight + 1);
    const turn = {
      ...input,
      permissionMode: selectMode(
        threadId,
        requestedMode(params) ?? modes.get(threadId) ?? "default",
      ),
    };
    const request = { id, turnId: newTurnId(), answered: inFlight > 0 };
    if (request.answered) {
      const waiting = renderTurnStarted({
        threadId,
        turnId: request.turnId,
        cwd: checked.thread.cwd,
        now: now(),
      });
      send({ id, result: { turn: waiting.turn } });
    }
    void runTurn(request, checked.thread, threadId, turn, messageId).then(
      () => {
        const left = (turnsInFlight.get(threadId) ?? 1) - 1;
        if (left > 0) {
          turnsInFlight.set(threadId, left);
          return;
        }
        turnsInFlight.delete(threadId);
        scheduleIdleClose(threadId);
      },
    );
  };

  // Each worker keeps its own Claude process, so an idle one is closed; without a session id its next turn could not resume the conversation, so it stays.
  const scheduleIdleClose = (threadId: string) => {
    cancelIdleClose(threadId);
    const timer = setTimeout(() => {
      idleTimers.delete(threadId);
      const slot = sessions.get(threadId);
      if (slot === undefined) return;
      if (
        (sessionIds.get(threadId) ?? store.get(threadId)?.sessionId) == null
      ) {
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

  // Claude takes a steer at its next tool boundary, or runs it as its next turn when the running one has ended, and either way the app turn stays open until Claude has taken it.
  const steerTurn = ({ id, params }: AppRequest) => {
    const active = activeTurns.get(String(params.threadId));
    const state = active?.state;
    if (
      active === undefined ||
      state == null ||
      state.finished ||
      state.interrupting ||
      state.turnId !== params.expectedTurnId
    ) {
      refuse(id, "no_running_turn");
      return;
    }
    const input = textInput(params.input, null);
    if (input === null) {
      refuse(id, "text_only");
      return;
    }
    if (active.steers >= MAX_STEERS_PER_TURN) {
      refuse(id, "too_many_steers");
      return;
    }
    if (active.slot === null) {
      active.unsentSteers.push(input.text);
    } else if (sendSteer(active, active.slot, input.text).isErr()) {
      refuse(id, "steer_not_sent");
      return;
    }
    active.steers += 1;
    send({ id, result: { turnId: state.turnId } });
    log({ event: "claude_turn", step: "steered" });
    apply(active, renderUserInput(state, input.items, null, now()));
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

  // The reply comes first so the app sees it before the interrupted turn completes; a failed interrupt stops Claude by closing the session.
  const interruptTurn = ({ id, params }: AppRequest) => {
    const threadId = String(params.threadId);
    const active = activeTurns.get(threadId);
    if (
      active?.state == null ||
      active.state.finished ||
      active.state.turnId !== params.turnId
    ) {
      refuse(id, "no_running_turn");
      return;
    }
    // A stop while the session already has an interrupt in flight, from this turn or an earlier one, is answered without asking Claude again; that interrupt decides the session, and a turn that has not sent yet stops before sending.
    const repeated = active.state.interrupting;
    active.state = markInterrupting(active.state);
    send({ id, result: {} });
    appRequests.cancel(threadId);
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
      finish(active, { status: "interrupted" }, null);
    });
  };

  const selectMode = (threadId: string, mode: Mode) => {
    modes.set(threadId, mode);
    return mode;
  };

  // Closing ends each active turn's message stream, so no Claude process outlives the bridge.
  const closeAll = () => {
    closed = true;
    for (const threadId of [...idleTimers.keys()]) cancelIdleClose(threadId);
    appRequests.cancel(null);
    for (const [threadId, slot] of sessions) dropSession(threadId, slot);
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
      const saved = threadOf(threadId);
      const change =
        saved === undefined ? null : savedThreadChange(thread, saved);
      if (change !== null) {
        forgetMessage(threadId, messageId);
        refuseTurn(request, queued, change);
        return;
      }
      adopted.delete(threadId);
      // A model picked while the thread was being registered is saved now, since the registration carried the earlier one.
      const picked = models.get(threadId);
      if (picked !== undefined && picked !== store.get(threadId)?.model) {
        saveModel(threadId, picked);
      }
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
        // Without the saved id a restart could run the same message again, so the turn does not start.
        const saved = await recordMessage(threadId, messageId);
        if (saved.isErr()) {
          forgetMessage(threadId, messageId);
          refuseTurn(request, queued, "message_not_saved", saved.error);
          return Result.ok();
        }
        responded = true;
        const active: ActiveTurn = {
          threadId,
          state: null,
          link: null,
          slot: null,
          unsentSteers: [],
          pendingSteers: new Set(),
          steers: 0,
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
        active.link?.stopWrites();
        return active.link?.hasUnsettledWrite()
          ? Result.err(
              new LinkWriteUnsettled({
                message: "a thread tool write has an unknown outcome",
              }),
            )
          : Result.ok();
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
      // The store's message says why, such as an earlier turn whose outcome is unknown.
      refuseTurn(request, queued, "thread_busy", ran.error, ran.error.message);
      return;
    }
    log({
      event: "claude_turn",
      step: "run_state_not_saved",
      error: ran.error._tag,
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
    logRefusal(reason, cause);
    const started = renderTurnStarted({
      threadId,
      turnId: request.turnId,
      cwd: thread.cwd,
      now: now(),
    });
    const shown = renderUserInput(started.state, input.items, messageId, now());
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
    active: ActiveTurn,
    input: TurnInput,
    messageId: string | null,
  ) => {
    const threadId = record.threadId;
    const started = renderTurnStarted({
      threadId,
      turnId: request.turnId,
      cwd: record.worktree,
      now: now(),
    });
    apply(active, started);
    if (!request.answered)
      send({ id: request.id, result: { turn: started.turn } });
    log({ event: "claude_turn", step: "started" });
    apply(
      active,
      renderUserInput(started.state, input.items, messageId, now()),
    );

    await waitForPendingInterrupt(threadId);
    if (active.state?.interrupting) {
      finish(active, { status: "interrupted" }, null);
      return;
    }
    const slot = await sessionFor(record, model);
    if (slot.isErr()) {
      fail(active, slot.error);
      return;
    }
    active.link = slot.value.link;
    // Claude leaves plan mode when a plan is approved, so the mode the app asks for is set again on every turn.
    const mode = await slot.value.session.setPermissionMode(
      input.permissionMode,
    );
    if (mode.isErr()) {
      dropSession(threadId, slot.value);
      fail(active, mode.error);
      return;
    }
    if (active.state?.interrupting) {
      finish(active, { status: "interrupted" }, null);
      return;
    }
    slot.value.link.acceptWrites();
    const sent = slot.value.session.send(input.text);
    if (sent.isErr()) {
      dropSession(threadId, slot.value);
      fail(active, sent.error);
      return;
    }
    active.slot = slot.value;
    for (const steer of active.unsentSteers.splice(0)) {
      const steered = sendSteer(active, slot.value, steer);
      if (steered.isErr()) {
        dropSession(threadId, slot.value);
        fail(active, steered.error);
        return;
      }
    }
    let sessionId = sessionIds.get(threadId) ?? record.sessionId;
    while (active.state !== null && !active.state.finished) {
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
        fail(active, received.error);
        return;
      }
      const current = received.value.session_id;
      if (current !== undefined && current !== sessionId) {
        sessionId = current;
        sessionIds.set(threadId, current);
        const saved = await store.setSessionId(threadId, current);
        if (saved.isErr()) {
          log({
            event: "claude_turn",
            step: "session_not_saved",
            error: saved.error._tag,
          });
        }
      }
      const message = received.value;
      const steers =
        message.type === "result" ? steersAfter(active, message) : "none";
      if (message.type === "result" && steers !== "none") {
        apply(active, renderInterimResult(active.state, message, now()));
        if (steers === "queued") continue;
        // The steer may never run, so the user is told to send it again, and the session goes so a late run cannot leak into the next turn.
        dropSession(threadId, slot.value);
        finish(
          active,
          { status: "failed", message: STEER_UNCONFIRMED },
          "SteerUnconfirmed",
        );
        return;
      }
      apply(active, renderSdkMessage(active.state, message, now()));
      // A failed result leaves its steers unrun, so the session goes with them rather than run them into the next turn; after a stop, the interrupt receipt decides instead.
      if (
        active.state.finished &&
        !active.state.interrupting &&
        active.pendingSteers.size > 0
      ) {
        dropSession(threadId, slot.value);
      }
    }
  };

  const sendSteer = (active: ActiveTurn, slot: SessionSlot, text: string) => {
    const sent = slot.session.send(text);
    if (sent.isOk()) active.pendingSteers.add(sent.value);
    return sent;
  };

  const waitForPendingInterrupt = async (threadId: string) => {
    await sessions.get(threadId)?.pendingInterrupt;
  };

  // model is the one the turn was accepted with, since a change that arrives while the turn waits applies to the next turn.
  // model is the one the turn was accepted with, since a change that arrives while the turn waits applies to the next turn.
  const sessionFor = async (
    record: ThreadRecord,
    model: string,
  ): Promise<Result<SessionSlot, InferErr<SessionStart> | BridgeClosing>> => {
    const existing = sessions.get(record.threadId);
    if (existing?.model === model) return Result.ok(existing);
    if (existing !== undefined) dropSession(record.threadId, existing);
    if (closed) {
      return Result.err(
        new BridgeClosing({ message: refusalMessage("bridge_closing") }),
      );
    }
    // Each session gets its own thread tool server, since one server instance serves one Claude process.
    const link = openLink(record.threadId);
    // TODO: clear a stored session id that Claude can no longer resume in P11a, which decides how a missing session is shown; until then every turn of that thread fails the same way.
    const started = await startSession({
      cwd: record.worktree,
      model,
      ...resumeFrom(sessionIds.get(record.threadId) ?? record.sessionId),
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
    };
    sessions.set(record.threadId, slot);
    return Result.ok(slot);
  };

  // The SDK reports no message when a call is refused here, so the refusal is recorded on the turn to show its item as declined.
  const approveTool =
    (threadId: string): CanUseTool =>
    async (toolName, input, options) => {
      const active = activeTurns.get(threadId);
      const state = active?.state;
      if (active === undefined || !state || state.interrupting) {
        return declineTool(active, options.toolUseID, NO_TURN);
      }
      const block = { id: options.toolUseID, name: toolName, input };
      // A subagent's call has no item in the thread, so its prompt carries an id of its own.
      if (options.agentID === undefined) {
        apply(active, renderToolRequest(state, block, now()));
      }
      const item = active.state
        ? runningToolItem(active.state, options.toolUseID)
        : null;
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
          turnId: state.turnId,
          itemId: item?.id ?? `${state.turnId}-${options.toolUseID}`,
          now: now(),
        },
      );
      const answer = await appRequests.ask(
        threadId,
        prompt.method,
        prompt.params,
        options.signal,
      );
      const decision = prompt.decide(answer);
      return decision.behavior === "deny"
        ? declineTool(active, options.toolUseID, decision.message)
        : decision;
    };

  const declineTool = (
    active: ActiveTurn | undefined,
    toolUseId: string,
    message: string,
  ) => {
    if (active?.state) {
      active.state = markToolDeclined(active.state, toolUseId);
    }
    return { behavior: "deny" as const, message };
  };

  // The app may start the next turn as soon as it sees turn/completed, so the thread stops counting as active then; the store's per-thread queue still holds that turn until this one's marker is cleared.
  const apply = (
    active: ActiveTurn,
    rendered: Rendered,
    error: FailureTag | null = null,
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
    active: ActiveTurn,
    error: { _tag: FailureTag; message: string },
  ) =>
    finish(
      active,
      active.state?.interrupting
        ? { status: "interrupted" }
        : { status: "failed", message: error.message },
      error._tag,
    );

  const finish = (
    active: ActiveTurn,
    outcome: TurnOutcome,
    error: FailureTag | null,
  ) => {
    if (active.state === null || active.state.finished) return;
    apply(active, renderTurnCompleted(active.state, outcome, now()), error);
  };

  // A prompt still open when its turn ends can no longer change what Claude did, so it is closed with the turn.
  const release = (active: ActiveTurn) => {
    if (activeTurns.get(active.threadId) === active) {
      activeTurns.delete(active.threadId);
      appRequests.cancel(active.threadId);
    }
  };

  const dropSession = (threadId: string, slot: SessionSlot) => {
    if (sessions.get(threadId) === slot) sessions.delete(threadId);
    slot.session.close();
  };

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
    steerTurn,
    interruptTurn,
    changeModel,
    closeAll,
    reject,
    answerRequest: appRequests.answer,
    selectMode,
    modeOf: (threadId: string) => modes.get(threadId),
    isClaudeThread: (threadId: unknown) =>
      typeof threadId === "string" && threadOf(threadId) !== undefined,
    threadOf,
    adopt: (threadId: string, thread: Thread) => {
      if (store.get(threadId) === undefined) adopted.set(threadId, thread);
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
    case "idle_closed":
      return { event: entry.event, step: entry.step };
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
    case "interrupt_failed":
    case "session_not_saved":
    case "model_not_saved":
    case "run_state_not_saved":
      return { event: entry.event, step: entry.step, error: entry.error };
  }
};

// A list under its cap names every send the turn took, so a steer it leaves out runs as a later turn, even one that reached Claude after this result was written; a queued send the CLI counts promises that turn too.
// A capped list or the single last uuid of an older CLI may leave out a steer already taken, so with nothing counted as queued whether the steer runs is unknown.
// A failed result ends the turn, since the steer's run would otherwise hide its error.
const steersAfter = (
  active: ActiveTurn,
  result: SDKResultMessage,
): "none" | "queued" | "unknown" => {
  const listed = result.user_message_uuids;
  const taken =
    listed ??
    (result.user_message_uuid === undefined ? [] : [result.user_message_uuid]);
  for (const uuid of taken) active.pendingSteers.delete(uuid);
  if (active.state?.interrupting) return "none";
  if (result.subtype !== "success" || result.is_error) return "none";
  if (active.pendingSteers.size === 0) return "none";
  const complete = listed !== undefined && listed.length < TAKEN_UUIDS_LIMIT;
  return complete || (result.queued_turn_count ?? 0) > 0 ? "queued" : "unknown";
};

const resumeFrom = (sessionId: string | null) =>
  sessionId === null ? {} : { resume: sessionId };

const clientMessageId = (params: Record<string, unknown>) =>
  typeof params.clientUserMessageId === "string" &&
  params.clientUserMessageId !== ""
    ? params.clientUserMessageId
    : null;

const textInput = (
  value: unknown,
  delegated: string | null,
): TextInput | null => {
  const typed = Array.isArray(value) ? value : [];
  const items =
    delegated === null
      ? typed
      : [{ type: "text", text: delegated, text_elements: [] }, ...typed];
  if (items.length === 0) return null;
  const texts: string[] = [];
  for (const item of items) {
    if (!isTextItem(item)) return null;
    texts.push(item.text);
  }
  return { items: items as UserInput[], text: texts.join("\n") };
};

const isTextItem = (item: unknown): item is { type: "text"; text: string } =>
  typeof item === "object" &&
  item !== null &&
  "type" in item &&
  item.type === "text" &&
  "text" in item &&
  typeof item.text === "string";

const INVALID_REQUEST = -32600;

const IDLE_SESSION_MS = 10 * 60_000;

const NO_TURN = "no Claude turn is running to ask the app for approval";

// The SDK documents user_message_uuids as holding at most this many entries.
const TAKEN_UUIDS_LIMIT = 64;

// With the prompt, a turn's sends stay under the list cap, so the list names each of them.
const MAX_STEERS_PER_TURN = TAKEN_UUIDS_LIMIT - 2;

const STEER_UNCONFIRMED =
  "Claude may not have received the last steer; send it again if it was not answered";
