import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentMessageItem,
  AppNotification,
  ThreadItem,
  ToolItem,
  Turn,
  TurnError,
  UserInput,
} from "./protocol.ts";
import { abandonToolItem, completeToolItem, startToolItem } from "./tools.ts";

// Each function returns a new state and never changes the one it receives, so a turn can be replayed from fixed inputs.
export type TurnState = Readonly<Omit<Draft, "notifications">>;

export type Rendered = { state: TurnState; notifications: AppNotification[] };

export type TurnOutcome =
  | { status: "completed" }
  | { status: "failed"; message: string }
  | { status: "interrupted" };

export const startTurn = (params: {
  threadId: string;
  turnId: string;
  cwd: string;
  now: number;
}): Rendered & { turn: Turn } => {
  const draft = open({
    threadId: params.threadId,
    turnId: params.turnId,
    cwd: params.cwd,
    startedAtMs: params.now,
    nextItem: 1,
    blocks: {},
    pending: [],
    streamedMessageIds: [],
    tools: {},
    finalMessage: null,
    finished: false,
  });
  const turn: Turn = {
    id: params.turnId,
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: toSeconds(params.now),
    completedAt: null,
    durationMs: null,
  };
  notify(draft, params.now, {
    method: "thread/status/changed",
    params: {
      threadId: draft.threadId,
      status: { type: "active", activeFlags: [] },
    },
  });
  notify(draft, params.now, {
    method: "turn/started",
    params: { threadId: draft.threadId, turn },
  });
  return { ...seal(draft), turn };
};

// Used for the opening prompt and for each steer, since both appear as user messages in the thread.
export const renderUserInput = (
  state: TurnState,
  input: UserInput[],
  clientId: string | null,
  now: number,
): Rendered => {
  if (state.finished) return { state, notifications: [] };
  const draft = open(state);
  const item: ThreadItem = {
    type: "userMessage",
    id: nextItemId(draft),
    clientId,
    content: input,
  };
  itemStarted(draft, item, now);
  itemCompleted(draft, item, now);
  return seal(draft);
};

// Subagent messages stay inside their parent tool item, and anything after the turn ends is dropped.
export const renderSdkMessage = (
  state: TurnState,
  message: SDKMessage,
  now: number,
): Rendered => {
  if (state.finished) return { state, notifications: [] };
  const draft = open(state);
  switch (message.type) {
    case "stream_event":
      if (message.parent_tool_use_id === null) {
        renderStreamEvent(draft, message.event, now);
      }
      break;
    case "assistant":
      if (message.parent_tool_use_id === null) {
        renderAssistant(draft, message, now);
      }
      break;
    case "user":
      if (message.parent_tool_use_id === null && !("isReplay" in message)) {
        renderToolResults(draft, message, now);
      }
      break;
    case "system":
      if (message.subtype === "permission_denied") {
        markDeclined(draft, message.tool_use_id);
      }
      break;
    case "result":
      finish(draft, outcomeOf(message), now);
      break;
  }
  return seal(draft);
};

// Called directly for an interrupt or a stream failure, where no result message closes the turn.
export const finishTurn = (
  state: TurnState,
  outcome: TurnOutcome,
  now: number,
): Rendered => {
  if (state.finished) return { state, notifications: [] };
  const draft = open(state);
  finish(draft, outcome, now);
  return seal(draft);
};

const renderStreamEvent = (draft: Draft, event: StreamEvent, now: number) => {
  switch (event.type) {
    case "message_start":
      draft.streamedMessageIds.push(event.message.id);
      break;
    case "content_block_start":
      startBlock(draft, event.index, event.content_block.type, now);
      break;
    case "content_block_delta":
      appendBlock(draft, event.index, event.delta, now);
      break;
    case "content_block_stop":
      stopBlock(draft, event.index, now);
      break;
    case "message_delta":
      if (event.delta.stop_reason !== null) {
        flushPending(draft, phaseOf(event.delta.stop_reason), now);
      }
      break;
    case "message_stop":
      flushPending(draft, null, now);
      break;
  }
};

const startBlock = (draft: Draft, index: number, type: string, now: number) => {
  if (type === "text") {
    const block: OpenBlock = { kind: "text", id: nextItemId(draft), text: "" };
    draft.blocks[index] = block;
    itemStarted(draft, agentMessage(block.id, "", null), now);
  } else if (type === "thinking") {
    const block: OpenBlock = {
      kind: "reasoning",
      id: nextItemId(draft),
      text: "",
    };
    draft.blocks[index] = block;
    itemStarted(draft, reasoning(block.id, ""), now);
  }
};

const appendBlock = (
  draft: Draft,
  index: number,
  delta: StreamDelta,
  now: number,
) => {
  const block = draft.blocks[index];
  if (block?.kind === "text" && delta.type === "text_delta") {
    draft.blocks[index] = { ...block, text: block.text + delta.text };
    notify(draft, now, {
      method: "item/agentMessage/delta",
      params: { ...itemRef(draft, block.id), delta: delta.text },
    });
  } else if (block?.kind === "reasoning" && delta.type === "thinking_delta") {
    draft.blocks[index] = { ...block, text: block.text + delta.thinking };
    notify(draft, now, {
      method: "item/reasoning/textDelta",
      params: {
        ...itemRef(draft, block.id),
        delta: delta.thinking,
        contentIndex: 0,
      },
    });
  }
};

// Whether a text block is commentary or the final answer is known only from the stop reason that follows it, so its completion waits.
const stopBlock = (draft: Draft, index: number, now: number) => {
  const block = draft.blocks[index];
  if (block === undefined) return;
  delete draft.blocks[index];
  if (block.kind === "text") draft.pending.push(block);
  else itemCompleted(draft, reasoning(block.id, block.text), now);
};

const flushPending = (
  draft: Draft,
  phase: AgentMessageItem["phase"],
  now: number,
) => {
  for (const block of draft.pending.splice(0)) {
    completeMessage(draft, agentMessage(block.id, block.text, phase), now);
  }
};

// Without partial messages, or for a block the stream did not carry, the whole block arrives here at once.
const renderAssistant = (
  draft: Draft,
  message: SDKAssistantMessage,
  now: number,
) => {
  const streamed = draft.streamedMessageIds.includes(message.message.id);
  const phase = message.message.stop_reason
    ? phaseOf(message.message.stop_reason)
    : null;
  for (const block of message.message.content) {
    if (block.type === "tool_use") {
      startTool(draft, block, now);
    } else if (streamed) {
    } else if (block.type === "text") {
      const item = agentMessage(nextItemId(draft), block.text, phase);
      itemStarted(draft, { ...item, text: "" }, now);
      completeMessage(draft, item, now);
    } else if (block.type === "thinking") {
      const item = reasoning(nextItemId(draft), block.thinking);
      itemStarted(draft, reasoning(item.id, ""), now);
      itemCompleted(draft, item, now);
    }
  }
};

// Text before a tool call is commentary, and closing it first keeps the app's items in the order Claude produced them.
const startTool = (
  draft: Draft,
  block: { id: string; name: string; input: unknown },
  now: number,
) => {
  if (draft.tools[block.id] !== undefined) return;
  flushPending(draft, "commentary", now);
  const item = startToolItem(nextItemId(draft), block, draft.cwd);
  draft.tools[block.id] = { item, startedAtMs: now, declined: false };
  itemStarted(draft, item, now);
};

const renderToolResults = (
  draft: Draft,
  message: SDKUserMessage,
  now: number,
) => {
  const { content } = message.message;
  if (typeof content === "string") return;
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const tool = draft.tools[block.tool_use_id];
    if (tool === undefined) continue;
    delete draft.tools[block.tool_use_id];
    const item = completeToolItem(tool.item, {
      content: block.content,
      isError: block.is_error === true,
      declined: tool.declined,
      output: message.tool_use_result,
      durationMs: now - tool.startedAtMs,
    });
    itemCompleted(draft, item, now);
  }
};

const markDeclined = (draft: Draft, toolUseId: string) => {
  const tool = draft.tools[toolUseId];
  if (tool !== undefined) draft.tools[toolUseId] = { ...tool, declined: true };
};

const outcomeOf = (result: SDKResultMessage): TurnOutcome => {
  if (result.subtype === "success") {
    return result.is_error
      ? { status: "failed", message: result.result }
      : { status: "completed" };
  }
  const message = result.errors.join("\n");
  return {
    status: "failed",
    message: message === "" ? result.subtype : message,
  };
};

const finish = (draft: Draft, outcome: TurnOutcome, now: number) => {
  const completed = outcome.status === "completed";
  for (const block of Object.values(draft.blocks)) {
    if (block.kind === "text") draft.pending.push(block);
    else itemCompleted(draft, reasoning(block.id, block.text), now);
  }
  draft.blocks = {};
  flushPending(draft, completed ? "final_answer" : null, now);
  for (const tool of Object.values(draft.tools)) {
    itemCompleted(draft, abandonToolItem(tool.item), now);
  }
  draft.tools = {};
  const error: TurnError | null =
    outcome.status === "failed"
      ? {
          message: outcome.message,
          codexErrorInfo: null,
          additionalDetails: null,
        }
      : null;
  if (error !== null) {
    notify(draft, now, {
      method: "error",
      params: {
        error,
        willRetry: false,
        threadId: draft.threadId,
        turnId: draft.turnId,
      },
    });
  }
  notify(draft, now, {
    method: "thread/status/changed",
    params: { threadId: draft.threadId, status: { type: "idle" } },
  });
  notify(draft, now, {
    method: "turn/completed",
    params: {
      threadId: draft.threadId,
      turn: {
        id: draft.turnId,
        items:
          completed && draft.finalMessage !== null ? [draft.finalMessage] : [],
        itemsView: "summary",
        status: outcome.status,
        error,
        startedAt: toSeconds(draft.startedAtMs),
        completedAt: toSeconds(now),
        durationMs: now - draft.startedAtMs,
      },
    },
  });
  draft.finished = true;
};

const completeMessage = (draft: Draft, item: AgentMessageItem, now: number) => {
  if (item.phase === "final_answer") draft.finalMessage = item;
  itemCompleted(draft, item, now);
};

const itemStarted = (draft: Draft, item: ThreadItem, now: number) =>
  notify(draft, now, {
    method: "item/started",
    params: {
      item,
      threadId: draft.threadId,
      turnId: draft.turnId,
      startedAtMs: now,
    },
  });

const itemCompleted = (draft: Draft, item: ThreadItem, now: number) =>
  notify(draft, now, {
    method: "item/completed",
    params: {
      item,
      threadId: draft.threadId,
      turnId: draft.turnId,
      completedAtMs: now,
    },
  });

const notify = (
  draft: Draft,
  now: number,
  notification: DistributiveOmit<AppNotification, "emittedAtMs">,
) => {
  draft.notifications.push({
    ...notification,
    emittedAtMs: now,
  } as AppNotification);
};

// Item ids only need to be unique within the thread, and the turn id already is.
const nextItemId = (draft: Draft) => `${draft.turnId}-item-${draft.nextItem++}`;

const itemRef = (draft: Draft, itemId: string) => ({
  threadId: draft.threadId,
  turnId: draft.turnId,
  itemId,
});

const agentMessage = (
  id: string,
  text: string,
  phase: AgentMessageItem["phase"],
): AgentMessageItem => ({
  type: "agentMessage",
  id,
  text,
  phase,
  memoryCitation: null,
  delivery: null,
  questions: null,
});

const reasoning = (id: string, text: string): ThreadItem => ({
  type: "reasoning",
  id,
  summary: [],
  content: text === "" ? [] : [text],
});

const phaseOf = (stopReason: string): AgentMessageItem["phase"] =>
  CONTINUING_STOP_REASONS.has(stopReason) ? "commentary" : "final_answer";

const open = (state: TurnState): Draft => ({
  ...state,
  blocks: { ...state.blocks },
  pending: [...state.pending],
  streamedMessageIds: [...state.streamedMessageIds],
  tools: { ...state.tools },
  notifications: [],
});

const seal = ({ notifications, ...state }: Draft): Rendered => ({
  state,
  notifications,
});

const toSeconds = (ms: number) => Math.floor(ms / 1000);

const CONTINUING_STOP_REASONS = new Set(["tool_use", "pause_turn"]);

type Draft = {
  threadId: string;
  turnId: string;
  cwd: string;
  startedAtMs: number;
  nextItem: number;
  blocks: Record<number, OpenBlock>;
  pending: OpenBlock[];
  streamedMessageIds: string[];
  tools: Record<string, OpenTool>;
  finalMessage: AgentMessageItem | null;
  finished: boolean;
  notifications: AppNotification[];
};

type OpenBlock = { kind: "text" | "reasoning"; id: string; text: string };

type OpenTool = { item: ToolItem; startedAtMs: number; declined: boolean };

type StreamEvent = SDKPartialAssistantMessage["event"];

type StreamDelta = Extract<
  StreamEvent,
  { type: "content_block_delta" }
>["delta"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
