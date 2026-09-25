import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "better-result";
import type { ClaudeSessionSettings } from "../claude/session.ts";
import type { UserInput } from "../render/protocol.ts";
import {
  finishTurn,
  markInterrupting,
  markToolDeclined,
  type Rendered,
  renderSdkMessage,
  renderUserInput,
  startTurn,
  type TurnOutcome,
  type TurnState,
} from "../render/turn.ts";
import type { ThreadRecord, ThreadStore } from "../state/thread-store.ts";
import { isClaudeModel } from "./models.ts";

export type ClaudeSession = {
  messages: AsyncIterator<Result<SDKMessage, Failure>, void>;
  send: (text: string) => Result<string, Failure>;
  interrupt: () => Promise<Result<unknown, Failure>>;
  close: () => void;
};

export type StartSession = (
  settings: ClaudeSessionSettings,
) => Promise<Result<ClaudeSession, Failure>>;

// Only the step and an error tag or turn status are logged, never thread ids or text.
export type TurnEvent = {
  event: "claude_turn";
  step: TurnStep;
  detail: string | null;
};

export type AppRequest = {
  id: RequestId;
  params: Record<string, unknown>;
};

type TurnStep =
  | "refused"
  | "started"
  | "finished"
  | "session_not_saved"
  | "run_state_not_saved";

type RequestId = string | number;

type Failure = { _tag: string; message: string };

type Thread = { model: string; cwd: string };

type Running = { turnId: string | null; state: TurnState | null };

// A thread keeps one Claude session across turns; a session that fails is dropped and the next turn resumes it from the stored session id.
export const createTurnController = ({
  store,
  startSession,
  send,
  log,
  now = Date.now,
  newTurnId = () => `harnexus-turn-${randomUUID()}`,
}: {
  store: ThreadStore;
  startSession: StartSession;
  send: (message: object) => void;
  log: (event: TurnEvent) => void;
  now?: () => number;
  newTurnId?: () => string;
}) => {
  // Threads created with a Claude model are saved to the store only on their first turn, so a thread never used leaves nothing behind.
  const adopted = new Map<string, Thread>();
  const sessions = new Map<string, ClaudeSession>();
  const running = new Map<string, Running>();
  let closed = false;

  const threadOf = (threadId: string): Thread | undefined => {
    const record = store.get(threadId);
    return record === undefined
      ? adopted.get(threadId)
      : { model: record.model, cwd: record.worktree };
  };

  const refuse = (id: RequestId, message: string) => {
    send({ id, error: { code: INVALID_REQUEST, message } });
    log({ event: "claude_turn", step: "refused", detail: null });
  };

  const apply = (entry: Running, rendered: Rendered) => {
    entry.state = rendered.state;
    for (const notification of rendered.notifications) send(notification);
  };

  const finish = (entry: Running, outcome: TurnOutcome) => {
    if (entry.state === null || entry.state.finished) return;
    apply(entry, finishTurn(entry.state, outcome, now()));
    log({ event: "claude_turn", step: "finished", detail: outcome.status });
  };

  const dropSession = (threadId: string, session: ClaudeSession) => {
    if (sessions.get(threadId) === session) sessions.delete(threadId);
    session.close();
  };

  const sessionFor = async (record: ThreadRecord) => {
    const existing = sessions.get(record.threadId);
    if (existing !== undefined) return Result.ok(existing);
    const started = await startSession({
      cwd: record.worktree,
      model: record.model,
      ...(record.sessionId === null ? {} : { resume: record.sessionId }),
      onToolDeclined: (toolUseId) => {
        const entry = running.get(record.threadId);
        if (entry?.state)
          entry.state = markToolDeclined(entry.state, toolUseId);
      },
    });
    if (started.isErr()) return started;
    // Shutdown may have happened while Claude was starting.
    if (closed) {
      started.value.close();
      return Result.err({ _tag: "BridgeClosing", message: BRIDGE_CLOSING });
    }
    sessions.set(record.threadId, started.value);
    return started;
  };

  const executeTurn = async (
    requestId: RequestId,
    record: ThreadRecord,
    entry: Running,
    input: UserInput[],
    text: string,
  ) => {
    const threadId = record.threadId;
    const started = startTurn({
      threadId,
      turnId: newTurnId(),
      cwd: record.worktree,
      now: now(),
    });
    entry.turnId = started.turn.id;
    apply(entry, started);
    send({ id: requestId, result: { turn: started.turn } });
    log({ event: "claude_turn", step: "started", detail: null });
    apply(entry, renderUserInput(started.state, input, null, now()));

    const session = await sessionFor(record);
    if (session.isErr()) {
      finish(entry, { status: "failed", message: session.error.message });
      return;
    }
    if (entry.state?.interrupting) {
      finish(entry, { status: "interrupted" });
      return;
    }
    const sent = session.value.send(text);
    if (sent.isErr()) {
      dropSession(threadId, session.value);
      finish(entry, { status: "failed", message: sent.error.message });
      return;
    }
    let sessionId = record.sessionId;
    while (entry.state !== null && !entry.state.finished) {
      const next = await session.value.messages.next();
      const message = next.done === true ? STREAM_ENDED : next.value;
      if (typeof message === "string" || message.isErr()) {
        dropSession(threadId, session.value);
        finish(
          entry,
          entry.state.interrupting
            ? { status: "interrupted" }
            : {
                status: "failed",
                message:
                  typeof message === "string" ? message : message.error.message,
              },
        );
        return;
      }
      const current = message.value.session_id;
      if (current !== undefined && current !== sessionId) {
        sessionId = current;
        const saved = await store.setSession(threadId, current);
        if (saved.isErr()) {
          log({
            event: "claude_turn",
            step: "session_not_saved",
            detail: saved.error._tag,
          });
        }
      }
      apply(entry, renderSdkMessage(entry.state, message.value, now()));
    }
  };

  // A failed turn is shown to the user, who decides whether to send it again, so no turn outcome is treated as unknown here; only a crash leaves the marker.
  const runTurn = async (
    requestId: RequestId,
    threadId: string,
    thread: Thread,
    entry: Running,
    input: UserInput[],
    text: string,
  ) => {
    if (store.get(threadId) === undefined) {
      const registered = await store.register({
        threadId,
        model: thread.model,
        worktree: thread.cwd,
      });
      if (registered.isErr()) {
        refuse(requestId, registered.error.message);
        return;
      }
      adopted.delete(threadId);
    }
    let responded = false;
    const ran = await store.runWrite(
      threadId,
      async (record) => {
        responded = true;
        await executeTurn(requestId, record, entry, input, text);
        return Result.ok();
      },
      () => false,
    );
    if (ran.isOk()) return;
    if (!responded) refuse(requestId, ran.error.message);
    else {
      log({
        event: "claude_turn",
        step: "run_state_not_saved",
        detail: ran.error._tag,
      });
    }
  };

  return {
    isClaudeThread: (threadId: unknown) =>
      typeof threadId === "string" && threadOf(threadId) !== undefined,

    modelOf: (threadId: string) => threadOf(threadId)?.model,

    adopt: (threadId: string, thread: Thread) => {
      if (store.get(threadId) === undefined) adopted.set(threadId, thread);
    },

    // cwd is the thread's directory as last reported by the server, used when a Codex thread switches to Claude.
    startTurn: ({ id, params }: AppRequest, cwd: string | undefined) => {
      const threadId = params.threadId;
      if (typeof threadId !== "string") {
        refuse(id, "turn/start needs a threadId");
        return;
      }
      const known = threadOf(threadId);
      const model = params.model ?? known?.model;
      if (!isClaudeModel(model)) {
        refuse(id, "a Claude thread cannot switch to a Codex model");
        return;
      }
      // TODO: follow a model change within Claude in P10, which decides how the running session picks it up.
      if (known !== undefined && model !== known.model) {
        refuse(
          id,
          "changing the Claude model of a thread is not supported yet",
        );
        return;
      }
      const thread = known ?? (cwd === undefined ? undefined : { model, cwd });
      if (thread === undefined) {
        refuse(id, "the working directory of this thread is unknown");
        return;
      }
      const input = textInput(params.input);
      if (input === null) {
        refuse(id, "Claude threads accept text input only");
        return;
      }
      if (closed) {
        refuse(id, BRIDGE_CLOSING);
        return;
      }
      if (running.has(threadId)) {
        refuse(id, "a Claude turn is already running on this thread");
        return;
      }
      const entry: Running = { turnId: null, state: null };
      running.set(threadId, entry);
      void runTurn(id, threadId, thread, entry, input.items, input.text).then(
        () => running.delete(threadId),
      );
    },

    // The reply comes first so the app sees it before the interrupted turn completes; a failed interrupt stops Claude by closing the session.
    interruptTurn: ({ id, params }: AppRequest) => {
      const threadId = String(params.threadId);
      const entry = running.get(threadId);
      if (entry?.state == null || entry.turnId !== params.turnId) {
        refuse(id, "no running Claude turn matches turnId");
        return;
      }
      entry.state = markInterrupting(entry.state);
      send({ id, result: {} });
      const session = sessions.get(threadId);
      if (session === undefined) return;
      void session.interrupt().then((interrupted) => {
        if (interrupted.isOk() || running.get(threadId) !== entry) return;
        dropSession(threadId, session);
        finish(entry, { status: "interrupted" });
      });
    },

    // TODO: pass steers into the running turn in P10.
    refuseSteer: ({ id }: AppRequest) =>
      refuse(id, "steering a Claude turn is not supported yet"),

    // Closing ends each running turn's message stream, so no Claude process outlives the bridge.
    closeAll: () => {
      closed = true;
      for (const [threadId, session] of sessions)
        dropSession(threadId, session);
    },
  };
};

const textInput = (value: unknown) => {
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

const BRIDGE_CLOSING = "the bridge is shutting down";

const STREAM_ENDED = "Claude stopped before the turn finished";
