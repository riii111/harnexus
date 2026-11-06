import { z } from "zod";

// Every line either way names this version, so a bridge and an adapter of different versions refuse each other before acting.
export const ADAPTER_PROTOCOL_VERSION = 1;

const V = z.literal(ADAPTER_PROTOCOL_VERSION);

const ID = z.union([z.string().min(1), z.number().int()]);

const BINDING = z.strictObject({
  conversationId: z.string().min(1),
  threadId: z.string().min(1),
});

export type DeclaredBinding = z.infer<typeof BINDING>;

const HELLO = z.strictObject({
  v: V,
  type: z.literal("hello"),
  adapterId: z.string().min(1),
  bindings: z.array(BINDING).default([]),
});

const OBSERVED = z.strictObject({
  v: V,
  type: z.literal("observed"),
  eventId: z.string().min(1),
});

const TURN_OUTPUT = z.strictObject({
  v: V,
  type: z.literal("turn_output"),
  turnId: z.string().min(1),
  text: z.string(),
  phase: z.enum(["commentary", "final"]).default("final"),
});

const TURN_END = z.strictObject({
  v: V,
  type: z.literal("turn_end"),
  turnId: z.string().min(1),
  status: z.enum(["completed", "failed"]),
  message: z.string().optional(),
});

// Answers a request the bridge sent, which is only history.
const RESPONSE = z.strictObject({
  v: V,
  type: z.literal("response"),
  id: z.string().min(1),
  outcome: z.string(),
  entries: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant"]),
        text: z.string(),
        at: z.string(),
      }),
    )
    .optional(),
});

export type HistoryEntry = NonNullable<
  z.infer<typeof RESPONSE>["entries"]
>[number];

const REQUEST_BASE = { v: V, type: z.literal("request"), id: ID };

const REQUEST = z.discriminatedUnion("op", [
  z.strictObject({
    ...REQUEST_BASE,
    op: z.literal("list_projects"),
    callerThreadId: z.string().min(1),
  }),
  z.strictObject({
    ...REQUEST_BASE,
    op: z.literal("create_conversation"),
    conversationId: z.string().min(1),
    callerThreadId: z.string().min(1),
    // create_thread's arguments without its prompt, which the bridge writes.
    arguments: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    ...REQUEST_BASE,
    op: z.literal("bind_conversation"),
    conversationId: z.string().min(1),
    threadId: z.string().min(1),
  }),
  z.strictObject({
    ...REQUEST_BASE,
    op: z.literal("post"),
    conversationId: z.string().min(1),
    text: z.string().min(1),
  }),
  z.strictObject({
    ...REQUEST_BASE,
    op: z.literal("cloud_send"),
    sessionId: z.string().min(1),
    text: z.string().min(1),
  }),
]);

export type AdapterRequest = z.infer<typeof REQUEST>;

export const ADAPTER_MESSAGE = z.union([
  HELLO,
  OBSERVED,
  TURN_OUTPUT,
  TURN_END,
  RESPONSE,
  REQUEST,
]);

export type AdapterMessage = z.infer<typeof ADAPTER_MESSAGE>;

// The ops that make, answer or send for a conversation, which an observing adapter is refused.
export const WRITE_OPS: ReadonlySet<AdapterRequest["op"]> = new Set([
  "create_conversation",
  "bind_conversation",
  "post",
  "cloud_send",
]);

// done: carried out; not_sent: certainly not carried out, so it may be asked again; rejected: refused and not carried out; unknown: may have been carried out, so it must not be asked again; invalid: not understood.
export type AdapterOutcome =
  | "done"
  | "not_sent"
  | "rejected"
  | "unknown"
  | "invalid";

export type RefusalReason =
  | "observe_only"
  | "not_ready"
  | "unknown_caller"
  | "not_linked"
  | "unbound"
  | "pending_create"
  | "binding_conflict"
  | "has_conversation"
  | "not_claude_model"
  | "state_unavailable"
  | "busy";

// The prompt a chat made for a conversation opens with names only the intent, so the chat's first turn is told apart from any other before its create answers.
const FIRST_TURN_COMMAND = "/external-conversation";

export const firstTurnPrompt = (intentId: string) =>
  `${FIRST_TURN_COMMAND} ${intentId}`;

export const intentOfFirstTurn = (text: string) =>
  FIRST_TURN.exec(text.trim())?.[1] ?? null;

const FIRST_TURN = /^\/external-conversation ([0-9a-f-]{36})$/;
