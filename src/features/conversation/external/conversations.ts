import { randomUUID } from "node:crypto";

import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import { isClaudeModel } from "../../../infra/claude/models.ts";
import type {
  ConversationBinding,
  CreateIntent,
  ExternalConversationState,
} from "../../../infra/external-conversations.ts";
import { parseJson } from "../../../lib/json.boundary.ts";
import { isObject } from "../../../lib/object.ts";
import type { LineProcess } from "../../../lib/process.boundary.ts";
import { createSerialQueue } from "../../../lib/serial-queue.ts";
import {
  ADAPTER_MESSAGE,
  ADAPTER_PROTOCOL_VERSION,
  type AdapterMessage,
  type AdapterOutcome,
  type AdapterRequest,
  type DeclaredBinding,
  firstTurnPrompt,
  type HistoryEntry,
  intentOfFirstTurn,
  type RefusalReason,
  WRITE_OPS,
} from "./protocol.ts";

// What a copy of a linked Cloud session showed: linked for the copy made when the chat was linked, continued for every later one.
export type SessionObservation = {
  sessionId: string;
  parentThreadId: string;
  phase: "linked" | "continued";
  // The last record the app was shown before this copy, or null.
  shownBefore: string | null;
  records: readonly SessionMessage[];
};

// What happened to a turn handed to the adapter; lost means the adapter went away before it ended the turn.
export type TurnSink = {
  output: (text: string, phase: "commentary" | "final") => void;
  end: (status: "completed" | "failed", message: string | null) => void;
  lost: () => void;
};

export type ConversationRoute =
  | { kind: "normal" }
  | { kind: "stopped"; message: string }
  | { kind: "bound"; conversationId: string; opened: boolean };

type Answer = {
  outcome: AdapterOutcome;
  reason?: RefusalReason;
  message?: string;
  [key: string]: unknown;
};

export type ExternalLogEvent =
  | {
      event: "external_adapter";
      step:
        | "started"
        | "connected"
        | "exited"
        | "handshake_timeout"
        | "version_refused"
        | "id_refused"
        | "line_invalid"
        | "answer_lost"
        | "state_unwritable"
        | "binding_conflict";
    }
  | {
      event: "external_adapter";
      step: "request";
      op: AdapterRequest["op"];
      outcome: AdapterOutcome;
    };

export type SpawnAdapter = (handlers: {
  onLine: (line: string) => void;
  onExit: () => void;
}) => LineProcess;

// Migration only: a review the old writer has in memory only, unsent, to be handed to the adapter's journal before the old bridge stops.
// TODO(S5): remove with the old Cloud review writer.
export type LegacyUnsentReview = {
  parentThreadId: string;
  review: Record<string, unknown>;
};

export type ExternalConversations = ReturnType<
  typeof createExternalConversations
>;

// Starts the adapter the user registered and keeps one connection to it: what it is told of Cloud sessions and chats, and what it asks this bridge to do.
export const createExternalConversations = ({
  adapterId,
  mode,
  bridgeId,
  spawn,
  state,
  save,
  call,
  isCaller,
  holdsConversation,
  cloudOwner,
  sendToSession,
  log,
  now = Date.now,
  schedule = defaultSchedule,
  newId = randomUUID,
  handshakeMs = HANDSHAKE_MS,
  historyMs = HISTORY_MS,
  postMs = POST_MS,
}: {
  adapterId: string;
  mode: "observe" | "write";
  bridgeId: string;
  spawn: SpawnAdapter;
  // Null when the file could not be read, so nothing is written over it and no first turn is taken for an intent.
  state: ExternalConversationState | null;
  save: (state: ExternalConversationState) => Promise<boolean>;
  // The bridge's own call gateway, answering version 1 lines.
  call: (line: string) => Promise<string>;
  isCaller: (threadId: string) => boolean;
  // Whether a chat holds a conversation of Claude's or a Cloud session, so it is never bound.
  holdsConversation: (threadId: string) => boolean;
  cloudOwner: (sessionId: string) => string | undefined;
  sendToSession: (
    sessionId: string,
    text: string,
  ) => Promise<{
    outcome: "done" | "rejected" | "unknown";
    message?: string;
  }>;
  log: (event: ExternalLogEvent) => void;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => () => void;
  newId?: () => string;
  handshakeMs?: number;
  historyMs?: number;
  postMs?: number;
}) => {
  const writes = createSerialQueue();
  // Binds and creates are checked and saved one at a time, so none is answered before the change it relies on is saved.
  const changes = createSerialQueue();
  const bindings = new Map<string, ConversationBinding>(
    (state?.bindings ?? []).map((binding) => [binding.threadId, binding]),
  );
  const intents = new Map<string, CreateIntent>(
    (state?.intents ?? []).map((intent) => [intent.intentId, intent]),
  );
  const writable = state !== null;
  // Threads whose declared binding contradicts another, whose turns are stopped until a later declaration settles them.
  const conflicts = new Set<string>();
  // The creates waiting for their chat's first turn, by intent.
  const created = new Map<string, (threadId: string) => void>();

  let current: LineProcess | null = null;
  let connected = false;
  let connectedAt = 0;
  let closed = false;
  let refused = false;
  let failures = 0;
  let cancelTimer: (() => void) | null = null;
  let markReady: () => void = () => {};
  const firstConnection = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const liveTurns = new Map<string, { threadId: string; sink: TurnSink }>();
  const asks = new Map<string, (entries: HistoryEntry[] | null) => void>();
  const posts = new Map<string, { text: string; shown: () => void }[]>();
  let startOwnTurn: (threadId: string) => boolean = () => false;
  let sequence = 0;

  // The latest observation of each session, sent again on each new connection, and which ones the adapter has not confirmed it took as a link.
  const observations = new Map<string, SessionObservation>();
  const unconfirmedLinks = new Map<
    string,
    { link: string; linkedAt: string | null }
  >();
  const linkEvents = new Map<string, { sessionId: string; link: string }>();
  let sentKeys = new Map<string, string>();
  let legacyUnsent: readonly LegacyUnsentReview[] = [];

  const sendLine = (message: object) =>
    current?.send(
      JSON.stringify({ v: ADAPTER_PROTOCOL_VERSION, ...message }),
    ) ?? false;

  const nextId = (prefix: string) => `${prefix}-${bridgeId}-${++sequence}`;

  const persist = () =>
    writes.run("state", async () => {
      if (!writable) return false;
      const saved = await save({
        bindings: [...bindings.values()],
        intents: [...intents.values()],
      });
      if (!saved) log({ event: "external_adapter", step: "state_unwritable" });
      return saved;
    });

  const threadOfConversation = (conversationId: string) => {
    for (const binding of bindings.values()) {
      if (
        binding.adapterId === adapterId &&
        binding.conversationId === conversationId
      )
        return binding.threadId;
    }

    return undefined;
  };

  const intentOfConversation = (conversationId: string) =>
    [...intents.values()].find(
      (intent) =>
        intent.adapterId === adapterId &&
        intent.conversationId === conversationId,
    );

  const dropIntents = (conversationId: string) => {
    for (const [intentId, intent] of intents) {
      if (
        intent.adapterId === adapterId &&
        intent.conversationId === conversationId
      )
        intents.delete(intentId);
    }
  };

  const ownBindings = () =>
    [...bindings.values()].filter((binding) => binding.adapterId === adapterId);

  // A process that neither answers nor exits is not waited for longer than its handshake.
  const untilFirstConnection = () =>
    connected || mode !== "write"
      ? Promise.resolve()
      : Promise.race([firstConnection, delay(schedule, handshakeMs)]);

  const connect = () => {
    if (closed || refused) return;
    const opened = spawn({
      onLine: (line) => {
        if (current === opened) receive(opened, line);
      },
      onExit: () => exited(opened),
    });
    current = opened;
    log({ event: "external_adapter", step: "started" });
    sendLine({
      type: "hello",
      bridgeId,
      adapterId,
      mode,
      versions: [ADAPTER_PROTOCOL_VERSION],
    });
    cancelTimer = schedule(() => {
      if (current !== opened || connected) return;
      log({ event: "external_adapter", step: "handshake_timeout" });
      opened.stop();
    }, handshakeMs);
  };

  const exited = (process: LineProcess) => {
    if (current !== process) return;
    cancelTimer?.();
    cancelTimer = null;
    current = null;
    const lasted = connected && now() - connectedAt >= STEADY_MS;
    connected = false;
    log({ event: "external_adapter", step: "exited" });
    // A turn the adapter held cannot end any other way, so it ends as stopped rather than going to Claude.
    for (const [turnId, turn] of liveTurns) {
      liveTurns.delete(turnId);
      turn.sink.lost();
    }

    for (const [id, answer] of asks) {
      asks.delete(id);
      answer(null);
    }

    markReady();
    if (closed || refused) return;
    failures = lasted ? 0 : failures + 1;
    cancelTimer = schedule(
      connect,
      Math.min(RESTART_MS * 2 ** Math.max(0, failures - 1), MAX_RESTART_MS),
    );
  };

  const receive = (process: LineProcess, line: string) => {
    const parsed = parseJson(line);
    const value = parsed.isOk() ? parsed.value : undefined;
    if (isObject(value) && value.v !== ADAPTER_PROTOCOL_VERSION) {
      if (value.type === "hello") {
        refused = true;
        log({ event: "external_adapter", step: "version_refused" });
        process.stop();
        return;
      }

      if (value.type === "request" && "id" in value)
        sendLine({
          type: "response",
          id: value.id,
          bridgeId,
          outcome: "invalid",
          message: `protocol version ${JSON.stringify(value.v)} is not supported`,
          versions: [ADAPTER_PROTOCOL_VERSION],
        });
      return;
    }

    const message = ADAPTER_MESSAGE.safeParse(value);
    if (!message.success) {
      log({ event: "external_adapter", step: "line_invalid" });
      if (isObject(value) && value.type === "request" && "id" in value)
        sendLine({
          type: "response",
          id: value.id,
          bridgeId,
          outcome: "invalid",
          message: "the request does not match any op of version 1",
        });
      return;
    }

    handle(process, message.data);
  };

  const handle = (process: LineProcess, message: AdapterMessage) => {
    if (message.type === "hello") {
      if (connected) return;
      if (message.adapterId !== adapterId) {
        refused = true;
        log({ event: "external_adapter", step: "id_refused" });
        process.stop();
        return;
      }

      void greet(message.bindings);
      return;
    }

    if (!connected) {
      if (message.type === "request")
        sendLine({
          type: "response",
          id: message.id,
          bridgeId,
          outcome: "not_sent",
          reason: "not_ready",
        });
      return;
    }

    switch (message.type) {
      case "observed": {
        const event = linkEvents.get(message.eventId);
        linkEvents.delete(message.eventId);
        if (
          event !== undefined &&
          unconfirmedLinks.get(event.sessionId)?.link === event.link
        )
          unconfirmedLinks.delete(event.sessionId);
        return;
      }

      case "turn_output":
        liveTurns.get(message.turnId)?.sink.output(message.text, message.phase);
        return;
      case "turn_end": {
        const turn = liveTurns.get(message.turnId);
        if (turn === undefined) return;
        liveTurns.delete(message.turnId);
        turn.sink.end(message.status, message.message ?? null);
        return;
      }

      case "response": {
        const answer = asks.get(message.id);
        asks.delete(message.id);
        answer?.(message.outcome === "done" ? (message.entries ?? []) : null);
        return;
      }

      case "request":
        void answerRequest(message).then((answer) => {
          log({
            event: "external_adapter",
            step: "request",
            op: message.op,
            outcome: answer.outcome,
          });
          // An answer is given only on the connection that asked; a later connection is never told it, and the request is never carried out again.
          if (current !== process || !connected) {
            log({ event: "external_adapter", step: "answer_lost" });
            return;
          }

          sendLine({ type: "response", id: message.id, bridgeId, ...answer });
        });
    }
  };

  const greet = async (declared: readonly DeclaredBinding[]) => {
    if (mode === "write") await adopt(declared);
    cancelTimer?.();
    cancelTimer = null;
    connected = true;
    connectedAt = now();
    sentKeys = new Map();
    log({ event: "external_adapter", step: "connected" });
    sendLine({
      type: "ready",
      bridgeId,
      bindings:
        mode === "write"
          ? ownBindings().map(({ conversationId, threadId }) => ({
              conversationId,
              threadId,
            }))
          : [],
      pending:
        mode === "write"
          ? [...intents.values()]
              .filter((intent) => intent.adapterId === adapterId)
              .map((intent) => intent.conversationId)
          : [],
      conflicts: [...conflicts],
    });
    markReady();
    for (const observation of observations.values())
      sendObservation(observation);
    // TODO(S5): remove with the old Cloud review writer.
    if (mode === "observe" && legacyUnsent.length > 0)
      sendLine({
        type: "event",
        event: "migration_unsent_reviews",
        entries: legacyUnsent,
      });
  };

  // Takes the bindings the adapter declared from its own record; a binding only this bridge knows, such as one a first turn confirmed while the adapter was away, is kept and told to it.
  const adopt = async (declared: readonly DeclaredBinding[]) => {
    conflicts.clear();
    const threadCount = new Map<string, number>();
    const conversationCount = new Map<string, number>();
    for (const { threadId, conversationId } of declared) {
      threadCount.set(threadId, (threadCount.get(threadId) ?? 0) + 1);
      conversationCount.set(
        conversationId,
        (conversationCount.get(conversationId) ?? 0) + 1,
      );
    }

    let changed = false;
    for (const { threadId, conversationId } of declared) {
      const kept = bindings.get(threadId);
      const other = threadOfConversation(conversationId);
      if (
        (threadCount.get(threadId) ?? 0) > 1 ||
        (conversationCount.get(conversationId) ?? 0) > 1 ||
        (kept !== undefined &&
          (kept.adapterId !== adapterId ||
            kept.conversationId !== conversationId)) ||
        (other !== undefined && other !== threadId) ||
        (kept === undefined && holdsConversation(threadId))
      ) {
        conflicts.add(threadId);
        if (other !== undefined && other !== threadId) conflicts.add(other);
        continue;
      }

      if (kept === undefined) {
        bindings.set(threadId, { adapterId, conversationId, threadId });
        changed = true;
      }

      if (intentOfConversation(conversationId) !== undefined) {
        dropIntents(conversationId);
        changed = true;
      }
    }

    if (conflicts.size > 0)
      log({ event: "external_adapter", step: "binding_conflict" });
    if (changed) await persist();
  };

  const answerRequest = async (request: AdapterRequest): Promise<Answer> => {
    if (mode === "observe" && WRITE_OPS.has(request.op))
      return {
        outcome: "rejected",
        reason: "observe_only",
        message:
          "this adapter is registered to observe only, so the bridge carries out no writes for it",
      };
    switch (request.op) {
      case "list_projects":
        return listProjects(request.callerThreadId);
      case "create_conversation":
        return createConversation(request);
      case "bind_conversation":
        return bindConversation(request.conversationId, request.threadId);
      case "post":
        return post(request.conversationId, request.text);
      case "cloud_send":
        return cloudSend(request.sessionId, request.text);
    }
  };

  const viaGateway = async (
    threadId: string,
    tool: string,
    args: Record<string, unknown>,
  ) => {
    const parsed = parseJson(
      await call(
        JSON.stringify({
          version: 1,
          threadId,
          tool,
          arguments: args,
        }),
      ),
    );
    return parsed.isOk() && isObject(parsed.value) ? parsed.value : {};
  };

  const listProjects = async (callerThreadId: string): Promise<Answer> => {
    if (!isCaller(callerThreadId))
      return { outcome: "rejected", reason: "unknown_caller" };
    const answered = await viaGateway(callerThreadId, "list_projects", {});
    return {
      outcome: outcomeOf(answered.outcome),
      ...(answered.result !== undefined && { result: answered.result }),
      ...(typeof answered.message === "string" && {
        message: answered.message,
      }),
    };
  };

  const createConversation = async ({
    conversationId,
    callerThreadId,
    arguments: args,
  }: Extract<
    AdapterRequest,
    { op: "create_conversation" }
  >): Promise<Answer> => {
    const registered = await changes.run("bindings", () =>
      register(conversationId, callerThreadId, args),
    );
    return "outcome" in registered ? registered : askToCreate(registered, args);
  };

  // Saves the intent of a create, or answers why none is made.
  const register = async (
    conversationId: string,
    callerThreadId: string,
    args: Record<string, unknown>,
  ): Promise<Answer | CreateIntent> => {
    const existing = threadOfConversation(conversationId);
    if (existing !== undefined)
      return { outcome: "done", threadId: existing, existing: true };
    if (!writable) return { outcome: "not_sent", reason: "state_unavailable" };
    // A create whose outcome is not known stays registered, so it is never asked of the app again.
    if (intentOfConversation(conversationId) !== undefined)
      return {
        outcome: "unknown",
        reason: "pending_create",
        message:
          "an earlier create of this conversation has not been settled, so another is not sent",
      };
    if (!isCaller(callerThreadId))
      return { outcome: "rejected", reason: "unknown_caller" };
    // Only a Claude chat's first turn reaches the bridge, so a chat on another model would run its prompt as a turn.
    if (!isClaudeModel(args.model))
      return { outcome: "invalid", reason: "not_claude_model" };
    const intent: CreateIntent = {
      intentId: newId(),
      adapterId,
      conversationId,
      callerThreadId,
      createdAt: new Date(now()).toISOString(),
    };
    intents.set(intent.intentId, intent);
    if (!(await persist())) {
      intents.delete(intent.intentId);
      return { outcome: "not_sent", reason: "state_unavailable" };
    }

    return intent;
  };

  const askToCreate = async (
    intent: CreateIntent,
    args: Record<string, unknown>,
  ): Promise<Answer> => {
    const { conversationId, callerThreadId } = intent;
    const firstTurn: { threadId: string | null } = { threadId: null };
    created.set(intent.intentId, (threadId) => {
      firstTurn.threadId = threadId;
    });
    const answered = await viaGateway(callerThreadId, "create_thread", {
      ...args,
      prompt: firstTurnPrompt(intent.intentId),
    });
    created.delete(intent.intentId);
    const outcome = outcomeOf(answered.outcome);
    const named =
      typeof answered.threadId === "string" ? answered.threadId : null;
    const bound = firstTurn.threadId ?? threadOfConversation(conversationId);
    if (bound !== undefined) return { outcome: "done", threadId: bound };
    if (named !== null && intents.has(intent.intentId)) {
      // The app made the chat but its first turn was refused or not seen, so it is bound by the answer.
      const confirmed = await confirm(intent, named);
      if (confirmed) return { outcome: "done", threadId: named };
    }

    if (
      outcome === "not_sent" ||
      outcome === "rejected" ||
      outcome === "invalid"
    ) {
      intents.delete(intent.intentId);
      await persist();
      return {
        outcome,
        ...(typeof answered.message === "string" && {
          message: answered.message,
        }),
      };
    }

    return {
      outcome: "unknown",
      reason: "pending_create",
      message:
        "the chat may have been made but its first turn was not seen; it is bound if that turn arrives, and it is not created again",
    };
  };

  // Binds the chat a create made; answers false when the conversation already shows in another chat.
  const confirm = async (intent: CreateIntent, threadId: string) => {
    const other = threadOfConversation(intent.conversationId);
    if (other !== undefined && other !== threadId) return false;
    const kept = bindings.get(threadId);
    if (kept !== undefined && kept.conversationId !== intent.conversationId)
      return false;
    bindings.set(threadId, {
      adapterId,
      conversationId: intent.conversationId,
      threadId,
    });
    dropIntents(intent.conversationId);
    created.get(intent.intentId)?.(threadId);
    // The binding holds in memory even when it cannot be saved; the adapter is told it, so its record rebuilds the copy.
    await persist();
    sendLine({
      type: "event",
      event: "conversation_bound",
      conversationId: intent.conversationId,
      threadId,
    });
    return true;
  };

  const bindConversation = (conversationId: string, threadId: string) =>
    changes.run("bindings", () => bindNow(conversationId, threadId));

  const bindNow = async (
    conversationId: string,
    threadId: string,
  ): Promise<Answer> => {
    const kept = bindings.get(threadId);
    if (kept !== undefined)
      return kept.adapterId === adapterId &&
        kept.conversationId === conversationId
        ? { outcome: "done", threadId }
        : { outcome: "rejected", reason: "binding_conflict" };
    const other = threadOfConversation(conversationId);
    if (other !== undefined)
      return { outcome: "rejected", reason: "binding_conflict" };
    if (!writable) return { outcome: "not_sent", reason: "state_unavailable" };
    if (!isCaller(threadId))
      return { outcome: "rejected", reason: "unknown_caller" };
    if (holdsConversation(threadId))
      return { outcome: "rejected", reason: "has_conversation" };
    const binding = { adapterId, conversationId, threadId };
    const dropped = [...intents.values()];
    bindings.set(threadId, binding);
    dropIntents(conversationId);
    if (!(await persist())) {
      bindings.delete(threadId);
      for (const intent of dropped) intents.set(intent.intentId, intent);
      return { outcome: "not_sent", reason: "state_unavailable" };
    }

    conflicts.delete(threadId);
    return { outcome: "done", threadId };
  };

  const post = async (
    conversationId: string,
    text: string,
  ): Promise<Answer> => {
    const threadId = threadOfConversation(conversationId);
    if (threadId === undefined)
      return { outcome: "rejected", reason: "unbound" };
    if (conflicts.has(threadId))
      return { outcome: "rejected", reason: "binding_conflict" };
    let shown = () => {};
    const done = new Promise<boolean>((resolve) => {
      shown = () => resolve(true);
    });
    const queue = posts.get(threadId) ?? [];
    const entry = { text, shown };
    queue.push(entry);
    posts.set(threadId, queue);
    if (!startOwnTurn(threadId)) {
      removePost(threadId, entry);
      return { outcome: "not_sent", reason: "busy" };
    }

    let timedOut = () => {};
    const late = new Promise<boolean>((resolve) => {
      timedOut = () => resolve(false);
    });
    const cancel = schedule(timedOut, postMs);
    const showed = await Promise.race([done, late]);
    cancel();
    // The turn was taken by the app, so the text may still be shown; it is not shown twice by a retry.
    return showed
      ? { outcome: "done", threadId }
      : { outcome: "unknown", threadId };
  };

  const removePost = (threadId: string, entry: object) => {
    const queue = posts.get(threadId) ?? [];
    const at = queue.indexOf(entry as (typeof queue)[number]);
    if (at !== -1) queue.splice(at, 1);
    if (queue.length === 0) posts.delete(threadId);
  };

  const cloudSend = async (
    sessionId: string,
    text: string,
  ): Promise<Answer> => {
    // Only a session linked to a chat of this bridge is sent to, so an adapter never reaches a session another bridge shows.
    if (cloudOwner(sessionId) === undefined)
      return { outcome: "rejected", reason: "not_linked" };
    return sendToSession(sessionId, text);
  };

  const sendObservation = (observation: SessionObservation) => {
    if (!connected) return;
    const { sessionId, parentThreadId } = observation;
    if (cloudOwner(sessionId) !== parentThreadId) {
      observations.delete(sessionId);
      return;
    }

    const pending = unconfirmedLinks.get(sessionId);
    const linked = pending?.link === parentThreadId;
    const key = `${linked ? "linked" : "continued"}\0${parentThreadId}\0${observation.records.length}\0${observation.records.at(-1)?.uuid ?? ""}`;
    if (sentKeys.get(sessionId) === key) return;
    const eventId = nextId("event");
    if (linked) linkEvents.set(eventId, { sessionId, link: parentThreadId });
    sendLine({
      type: "event",
      event: "session_records",
      eventId,
      sessionId,
      parentThreadId,
      link: parentThreadId,
      phase: linked ? "linked" : "continued",
      ...(linked && { linkedAt: pending.linkedAt }),
      shownBefore: observation.shownBefore,
      records: observation.records,
    });
    sentKeys.set(sessionId, key);
  };

  return {
    start: connect,
    // Settles once the first connection is made or fails, so a turn in a bound chat is routed by the adapter's declaration.
    ready: () => untilFirstConnection(),

    observe: (observation: SessionObservation) => {
      observations.set(observation.sessionId, observation);
      if (observation.phase === "linked")
        unconfirmedLinks.set(observation.sessionId, {
          link: observation.parentThreadId,
          linkedAt: observation.records.at(-1)?.uuid ?? null,
        });
      sendObservation(observation);
    },

    // TODO(S5): remove with the old Cloud review writer.
    noteLegacyUnsent: (entries: readonly LegacyUnsentReview[]) => {
      legacyUnsent = entries;
      if (mode === "observe" && connected)
        sendLine({
          type: "event",
          event: "migration_unsent_reviews",
          entries,
        });
    },

    isBound: (threadId: string) =>
      mode === "write" && (bindings.has(threadId) || conflicts.has(threadId)),

    route: async (
      threadId: string,
      firstTurn: { text: string; source: string | null } | null,
    ): Promise<ConversationRoute> => {
      if (mode !== "write") return NORMAL;
      await untilFirstConnection();
      if (conflicts.has(threadId))
        return { kind: "stopped", message: CONFLICT };
      const binding = bindings.get(threadId);
      if (binding !== undefined)
        return binding.adapterId === adapterId
          ? {
              kind: "bound",
              conversationId: binding.conversationId,
              opened: false,
            }
          : { kind: "stopped", message: OTHER_ADAPTER };
      const intentId =
        firstTurn === null ? null : intentOfFirstTurn(firstTurn.text);
      if (intentId === null) return NORMAL;
      const intent = intents.get(intentId);
      if (intent === undefined || intent.callerThreadId !== firstTurn?.source)
        return { kind: "stopped", message: UNKNOWN_FIRST_TURN };
      return (await confirm(intent, threadId))
        ? { kind: "bound", conversationId: intent.conversationId, opened: true }
        : { kind: "stopped", message: CONFLICT };
    },

    // Hands a turn of a bound chat to the adapter; false when no adapter is connected, so the turn is stopped.
    openTurn: (
      turn: {
        turnId: string;
        threadId: string;
        conversationId: string;
        kind: "opened" | "input";
        text: string;
      },
      sink: TurnSink,
    ) => {
      if (!connected) return false;
      liveTurns.set(turn.turnId, { threadId: turn.threadId, sink });
      if (!sendLine({ type: "event", event: "turn", ...turn })) {
        liveTurns.delete(turn.turnId);
        return false;
      }

      return true;
    },

    stopTurn: (turnId: string) => {
      if (!liveTurns.delete(turnId)) return;
      sendLine({ type: "event", event: "turn_stop", turnId });
    },

    takePost: (threadId: string) => {
      const queue = posts.get(threadId);
      const entry = queue?.shift();
      if (queue?.length === 0) posts.delete(threadId);
      return entry ?? null;
    },

    // The bound chat's conversation as the adapter keeps it, or null when it cannot be asked.
    history: async (threadId: string) => {
      const binding = bindings.get(threadId);
      if (binding === undefined || !connected) return null;
      const id = nextId("history");
      const answered = new Promise<HistoryEntry[] | null>((resolve) => {
        asks.set(id, resolve);
      });
      sendLine({
        type: "request",
        id,
        op: "history",
        conversationId: binding.conversationId,
        threadId,
      });
      const cancel = schedule(() => {
        asks.get(id)?.(null);
        asks.delete(id);
      }, historyMs);
      const entries = await answered;
      cancel();
      return entries;
    },

    listen: (start: (threadId: string) => boolean) => {
      startOwnTurn = start;
    },

    close: () => {
      closed = true;
      cancelTimer?.();
      current?.stop();
    },
  };
};

export const serializeExternalEvent = (entry: ExternalLogEvent) =>
  entry.step === "request"
    ? {
        event: entry.event,
        step: entry.step,
        op: entry.op,
        outcome: entry.outcome,
      }
    : { event: entry.event, step: entry.step };

const outcomeOf = (value: unknown): AdapterOutcome =>
  value === "done" ||
  value === "not_sent" ||
  value === "rejected" ||
  value === "invalid"
    ? value
    : // A create answered model_mismatch or first_turn_refused made its chat, so it counts with the calls whose effect may stand.
      value === "model_mismatch" || value === "first_turn_refused"
      ? "done"
      : "unknown";

const delay = (
  schedule: (run: () => void, ms: number) => () => void,
  ms: number,
) =>
  new Promise<void>((resolve) => {
    schedule(resolve, ms);
  });

const defaultSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

const NORMAL: ConversationRoute = { kind: "normal" };

const CONFLICT =
  "This chat's link to its outside conversation contradicts another, so nothing here is sent until the adapter declares it again.";

const OTHER_ADAPTER =
  "This chat shows an outside conversation of an adapter that is not registered now, so nothing here is sent.";

const UNKNOWN_FIRST_TURN =
  "This chat was opened for an outside conversation this bridge has no record of, so it was not run.";

const HANDSHAKE_MS = 10_000;
const HISTORY_MS = 10_000;
const POST_MS = 60_000;
const RESTART_MS = 1_000;
const MAX_RESTART_MS = 60_000;
// A connection that lasted this long resets the wait before the next restart.
const STEADY_MS = 60_000;
