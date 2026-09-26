import { randomUUID } from "node:crypto";
import {
  type InferErr,
  type InferOk,
  Result,
  TaggedError,
} from "better-result";
import type {
  ClaudeSessionSettings,
  startClaudeSession,
} from "../claude/session.ts";
import type { createCodexLink } from "../mcp/codex-link.ts";
import type { UserInput } from "../render/protocol.ts";
import {
  finishTurn,
  markInterrupting,
  markToolDeclined,
  startTurn as openTurn,
  type Rendered,
  renderSdkMessage,
  renderUserInput,
  type TurnOutcome,
  type TurnState,
} from "../render/turn.ts";
import type { ThreadRecord, ThreadStore } from "../state/thread-store.ts";
import {
  type AppRequest,
  checkThread,
  type Refusal,
  refusalMessage,
  savedThreadChange,
  type Thread,
} from "./thread-request.ts";

// Only steps, turn statuses, refusal reasons and error tags are logged, never thread ids or text.
export type TurnEvent =
  | { event: "claude_turn"; step: "started" | "queued" | "outcome_unknown" }
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
      step: "session_not_saved" | "run_state_not_saved";
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
  | InferErr<StreamedMessage>["_tag"]
  | InterruptTag
  | BridgeClosing["_tag"]
  | StreamEnded["_tag"];

// runWrite is generic in the operation's error, so the store's own tags are listed; a new tag there fails to compile here.
type StoreTag =
  | ErrorTag<ReturnType<ThreadStore["register"]>>
  | ErrorTag<ReturnType<ThreadStore["setSession"]>>
  | ErrorTag<ReturnType<ThreadStore["addMessageId"]>>
  | "ThreadNotFound"
  | "WriteOutcomeUnknown"
  | "WriteNotStarted"
  | "RunStateNotSaved";

// A session is not reused until its interrupt reports whether a send is still queued, which can arrive after the interrupted turn has ended.
type SessionSlot = {
  session: ClaudeSession;
  pendingInterrupt: Promise<void> | null;
  link: CodexLink;
};

// link is the thread tool server of the session the turn ran on, read when the turn ends to see whether a write was left undecided.
type ActiveTurn = {
  threadId: string;
  state: TurnState | null;
  link: CodexLink | null;
};

type TextInput = { items: UserInput[]; text: string };

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
}: {
  store: ThreadStore;
  startSession: StartSession;
  openLink: (threadId: string) => CodexLink;
  send: (message: object) => void;
  log: (event: TurnEvent) => void;
  now?: () => number;
  newTurnId?: () => string;
}) => {
  // Threads created with a Claude model are saved to the store only on their first turn, so a thread never used leaves nothing behind.
  const adopted = new Map<string, Thread>();
  const sessions = new Map<string, SessionSlot>();
  const activeTurns = new Map<string, ActiveTurn>();
  // A session id Claude reported but the store failed to save still resumes the conversation while the bridge runs.
  const sessionIds = new Map<string, string>();
  // Message ids accepted but not yet saved, so a copy arriving while the first waits or runs is caught too.
  const acceptedMessageIds = new Map<string, Set<string>>();
  const turnsInFlight = new Map<string, number>();
  let closed = false;

  // fallbackCwd is the thread's directory as last reported by the server, used when a Codex thread switches to Claude.
  // A turn/start on a busy thread, such as a reviewer's reply, waits in the store's per-thread queue instead of being refused.
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
    const input = textInput(params.input);
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
    const inFlight = turnsInFlight.get(threadId) ?? 0;
    if (inFlight > 0) log({ event: "claude_turn", step: "queued" });
    turnsInFlight.set(threadId, inFlight + 1);
    void runTurn(id, checked.thread, threadId, input, messageId).then(() => {
      const left = (turnsInFlight.get(threadId) ?? 1) - 1;
      if (left === 0) turnsInFlight.delete(threadId);
      else turnsInFlight.set(threadId, left);
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

  // Closing ends each active turn's message stream, so no Claude process outlives the bridge.
  const closeAll = () => {
    closed = true;
    for (const [threadId, slot] of sessions) dropSession(threadId, slot);
  };

  // A failed turn is shown to the user, who decides whether to send it again, so no turn outcome is treated as unknown here; only a crash or a thread tool write left undecided leaves the marker.
  const runTurn = async (
    requestId: AppRequest["id"],
    thread: Thread,
    threadId: string,
    input: TextInput,
    messageId: string | null,
  ) => {
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
        refuse(requestId, "thread_not_saved", registered.error);
        return;
      }
      // A turn accepted just before this one may have registered the thread first, with its own model and directory.
      const saved = threadOf(threadId);
      const change =
        saved === undefined ? null : savedThreadChange(thread, saved);
      if (change !== null) {
        forgetMessage(threadId, messageId);
        refuse(requestId, change);
        return;
      }
      adopted.delete(threadId);
    }
    let responded = false;
    const ran = await store.runWrite(
      threadId,
      async (record) => {
        if (closed) {
          forgetMessage(threadId, messageId);
          refuse(requestId, "bridge_closing");
          return Result.ok();
        }
        // Without the saved id a restart could run the same message again, so the turn does not start.
        const saved = await recordMessage(threadId, messageId);
        if (saved.isErr()) {
          forgetMessage(threadId, messageId);
          refuse(requestId, "message_not_saved", saved.error);
          return Result.ok();
        }
        responded = true;
        const active: ActiveTurn = { threadId, state: null, link: null };
        activeTurns.set(threadId, active);
        await streamTurn(requestId, record, active, input, messageId);
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
      refuse(requestId, "thread_busy", ran.error, ran.error.message);
      return;
    }
    log({
      event: "claude_turn",
      step: "run_state_not_saved",
      error: ran.error._tag,
    });
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
    requestId: AppRequest["id"],
    record: ThreadRecord,
    active: ActiveTurn,
    input: TextInput,
    messageId: string | null,
  ) => {
    const threadId = record.threadId;
    const started = openTurn({
      threadId,
      turnId: newTurnId(),
      cwd: record.worktree,
      now: now(),
    });
    apply(active, started);
    send({ id: requestId, result: { turn: started.turn } });
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
    const slot = await sessionFor(record);
    if (slot.isErr()) {
      fail(active, slot.error);
      return;
    }
    active.link = slot.value.link;
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
        const saved = await store.setSession(threadId, current);
        if (saved.isErr()) {
          log({
            event: "claude_turn",
            step: "session_not_saved",
            error: saved.error._tag,
          });
        }
      }
      apply(active, renderSdkMessage(active.state, received.value, now()));
    }
  };

  const waitForPendingInterrupt = async (threadId: string) => {
    await sessions.get(threadId)?.pendingInterrupt;
  };

  const sessionFor = async (
    record: ThreadRecord,
  ): Promise<Result<SessionSlot, InferErr<SessionStart> | BridgeClosing>> => {
    const existing = sessions.get(record.threadId);
    if (existing !== undefined) return Result.ok(existing);
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
      model: record.model,
      ...resumeFrom(sessionIds.get(record.threadId) ?? record.sessionId),
      mcpServers: { [link.server.name]: link.server },
      allowedTools: link.allowedTools,
      onToolDeclined: (toolUseId) => {
        const active = activeTurns.get(record.threadId);
        if (active?.state) {
          active.state = markToolDeclined(active.state, toolUseId);
        }
      },
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
      pendingInterrupt: null,
      link,
    };
    sessions.set(record.threadId, slot);
    return Result.ok(slot);
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
    apply(active, finishTurn(active.state, outcome, now()), error);
  };

  const release = (active: ActiveTurn) => {
    if (activeTurns.get(active.threadId) === active) {
      activeTurns.delete(active.threadId);
    }
  };

  const dropSession = (threadId: string, slot: SessionSlot) => {
    if (sessions.get(threadId) === slot) sessions.delete(threadId);
    slot.session.close();
  };

  const threadOf = (threadId: string): Thread | undefined => {
    const record = store.get(threadId);
    return record === undefined
      ? adopted.get(threadId)
      : { model: record.model, cwd: record.worktree };
  };

  const refuse = (
    id: AppRequest["id"],
    reason: Refusal,
    cause: { _tag: StoreTag } | null = null,
    message: string = refusalMessage(reason),
  ) => {
    reject({ id }, message);
    log({
      event: "claude_turn",
      step: "refused",
      reason,
      error: cause?._tag ?? null,
    });
  };

  // The router logs its own refusals, so this only answers the app.
  const reject = ({ id }: Pick<AppRequest, "id">, message: string) =>
    send({ id, error: { code: INVALID_REQUEST, message } });

  return {
    startTurn,
    interruptTurn,
    closeAll,
    reject,
    isClaudeThread: (threadId: unknown) =>
      typeof threadId === "string" && threadOf(threadId) !== undefined,
    threadOf,
    adopt: (threadId: string, thread: Thread) => {
      if (store.get(threadId) === undefined) adopted.set(threadId, thread);
    },
  };
};

const resumeFrom = (sessionId: string | null) =>
  sessionId === null ? {} : { resume: sessionId };

const clientMessageId = (params: Record<string, unknown>) =>
  typeof params.clientUserMessageId === "string" &&
  params.clientUserMessageId !== ""
    ? params.clientUserMessageId
    : null;

const textInput = (value: unknown): TextInput | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const texts: string[] = [];
  for (const item of value) {
    if (!isTextItem(item)) return null;
    texts.push(item.text);
  }
  return { items: value as UserInput[], text: texts.join("\n") };
};

const isTextItem = (item: unknown): item is { type: "text"; text: string } =>
  typeof item === "object" &&
  item !== null &&
  "type" in item &&
  item.type === "text" &&
  "text" in item &&
  typeof item.text === "string";

const INVALID_REQUEST = -32600;
