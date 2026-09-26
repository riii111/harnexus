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
  AppNotificationBody,
  FunctionCallOutputItem,
  ThreadItem,
  ToolItem,
  Turn,
  TurnError,
  UserInput,
} from "./protocol.ts";
import {
  abandonToolItem,
  completeToolItem,
  declineToolItem,
  startToolItem,
} from "./tools.ts";

// Each function returns a new state and never changes the one it receives, so a turn can be replayed from fixed inputs.
export type TurnState = Readonly<Omit<Draft, "notifications">>;

export type Rendered = { state: TurnState; notifications: AppNotification[] };

export type TurnOutcome =
  | { status: "completed" }
  | { status: "failed"; message: string }
  | { status: "interrupted" };

export const renderTurnStarted = (params: {
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
    openBlocks: {},
    pendingTexts: [],
    streamingMessageId: null,
    blockCounts: {},
    tools: {},
    declinedToolUseIds: [],
    finalMessage: null,
    interrupting: false,
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
export const renderToolOutput = (
  state: TurnState,
  output: Omit<FunctionCallOutputItem, "type" | "id">,
  now: number,
): Rendered => {
  if (state.finished) return { state, notifications: [] };
  const draft = open(state);
  const item: ThreadItem = {
    type: "functionCallOutput",
    id: nextItemId(draft),
    ...output,
  };
  itemStarted(draft, item, now);
  itemCompleted(draft, item, now);
  return seal(draft);
};

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
        draft.declinedToolUseIds.push(message.tool_use_id);
      }
      break;
    case "result":
      correctDenials(
        draft,
        message.permission_denials.map((denial) => denial.tool_use_id),
        now,
      );
      finish(
        draft,
        draft.interrupting ? { status: "interrupted" } : outcomeOf(message),
        now,
      );
      break;
  }
  return seal(draft);
};

// A steer Claude had not taken when its turn ended runs as Claude's next turn, which the app sees as the same turn, so this result closes nothing but its own items.
export const renderInterimResult = (
  state: TurnState,
  result: SDKResultMessage,
  now: number,
): Rendered => {
  if (state.finished) return { state, notifications: [] };
  const draft = open(state);
  correctDenials(
    draft,
    result.permission_denials.map((denial) => denial.tool_use_id),
    now,
  );
  closeBlocks(draft, now);
  flushPending(draft, null, now);
  return seal(draft);
};

// Called directly for an interrupt or a stream failure, where no result message closes the turn.
export const renderTurnCompleted = (
  state: TurnState,
  outcome: TurnOutcome,
  now: number,
): Rendered => {
  if (state.finished) return { state, notifications: [] };
  const draft = open(state);
  finish(draft, outcome, now);
  return seal(draft);
};

// A permission request can reach the bridge before the message carrying its tool call, and the app's prompt points at the tool's item, so the item starts here; the later tool call is skipped as already started.
export const renderToolRequest = (
  state: TurnState,
  block: { id: string; name: string; input: unknown },
  now: number,
): Rendered => {
  if (state.finished) return { state, notifications: [] };
  const draft = open(state);
  startTool(draft, block, now);
  return seal(draft);
};

export const runningToolItem = (
  state: TurnState,
  toolUseId: string,
): ToolItem | null => {
  const tool = state.tools[toolUseId];
  return tool?.state === "running" ? tool.item : null;
};

// An interrupted SDK query still ends with a result, which must close the turn as interrupted rather than failed.
export const markInterrupting = (state: TurnState): TurnState => ({
  ...state,
  interrupting: true,
});

// The permission callback refuses a tool without any SDK message saying so, so it reports the refusal here; the call may come before or after the tool item starts.
export const markToolDeclined = (
  state: TurnState,
  toolUseId: string,
): TurnState =>
  state.declinedToolUseIds.includes(toolUseId)
    ? state
    : {
        ...state,
        declinedToolUseIds: [...state.declinedToolUseIds, toolUseId],
      };

type Draft = {
  threadId: string;
  turnId: string;
  cwd: string;
  startedAtMs: number;
  nextItem: number;
  openBlocks: Record<number, OpenBlock>;
  pendingTexts: OpenBlock[];
  streamingMessageId: string | null;
  blockCounts: Record<string, { streamed: number; seen: number }>;
  tools: Record<string, TrackedTool>;
  declinedToolUseIds: string[];
  finalMessage: AgentMessageItem | null;
  interrupting: boolean;
  finished: boolean;
  notifications: AppNotification[];
};

type OpenBlock = { kind: "text" | "reasoning"; id: string; text: string };

// A tool is tracked from its start to the end of the turn so it never starts twice; only a failed one keeps its item, which a later denial corrects, so large outputs are not held until the turn ends.
type TrackedTool =
  | { state: "running"; item: ToolItem; startedAtMs: number }
  | { state: "failed"; item: ToolItem }
  | { state: "closed" };

type StreamEvent = SDKPartialAssistantMessage["event"];

type StreamDelta = Extract<
  StreamEvent,
  { type: "content_block_delta" }
>["delta"];

const renderStreamEvent = (draft: Draft, event: StreamEvent, now: number) => {
  switch (event.type) {
    case "message_start":
      closeBlocks(draft, now);
      flushPending(draft, null, now);
      draft.streamingMessageId = event.message.id;
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
      closeBlocks(draft, now);
      flushPending(draft, null, now);
      draft.streamingMessageId = null;
      break;
  }
};

const startBlock = (draft: Draft, index: number, type: string, now: number) => {
  if (type !== "text" && type !== "thinking") return;
  stopBlock(draft, index, now);
  countStreamedBlock(draft);
  if (type === "text") {
    const block: OpenBlock = { kind: "text", id: nextItemId(draft), text: "" };
    draft.openBlocks[index] = block;
    itemStarted(draft, agentMessage(block.id, "", null), now);
  } else {
    const block: OpenBlock = {
      kind: "reasoning",
      id: nextItemId(draft),
      text: "",
    };
    draft.openBlocks[index] = block;
    itemStarted(draft, reasoning(block.id, ""), now);
  }
};

const appendBlock = (
  draft: Draft,
  index: number,
  delta: StreamDelta,
  now: number,
) => {
  const block = draft.openBlocks[index];
  if (block?.kind === "text" && delta.type === "text_delta") {
    draft.openBlocks[index] = { ...block, text: block.text + delta.text };
    notify(draft, now, {
      method: "item/agentMessage/delta",
      params: { ...itemRef(draft, block.id), delta: delta.text },
    });
  } else if (block?.kind === "reasoning" && delta.type === "thinking_delta") {
    draft.openBlocks[index] = { ...block, text: block.text + delta.thinking };
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
  const block = draft.openBlocks[index];
  if (block === undefined) return;
  delete draft.openBlocks[index];
  if (block.kind === "text") draft.pendingTexts.push(block);
  else itemCompleted(draft, reasoning(block.id, block.text), now);
};

// A retried or abandoned message may never send its block stops, so its blocks close when the next message starts.
const closeBlocks = (draft: Draft, now: number) => {
  for (const index of Object.keys(draft.openBlocks)) {
    stopBlock(draft, Number(index), now);
  }
};

const countStreamedBlock = (draft: Draft) => {
  const id = draft.streamingMessageId;
  if (id === null) return;
  const counts = draft.blockCounts[id] ?? { streamed: 0, seen: 0 };
  draft.blockCounts[id] = { ...counts, streamed: counts.streamed + 1 };
};

const flushPending = (
  draft: Draft,
  phase: AgentMessageItem["phase"],
  now: number,
) => {
  for (const block of draft.pendingTexts.splice(0)) {
    completeMessage(draft, agentMessage(block.id, block.text, phase), now);
  }
};

// Without partial messages, or for a block the stream did not carry, the whole block arrives here at once; an SDK-made API error message is skipped because the result reports the same error.
const renderAssistant = (
  draft: Draft,
  message: SDKAssistantMessage,
  now: number,
) => {
  if (message.error !== undefined) return;
  const phase = message.message.stop_reason
    ? phaseOf(message.message.stop_reason)
    : null;
  for (const block of message.message.content) {
    if (block.type === "tool_use") {
      startTool(draft, block, now);
    } else if (
      (block.type === "text" || block.type === "thinking") &&
      !consumeStreamedBlock(draft, message.message.id)
    ) {
      renderWholeBlock(draft, block, now);
    }
  }
  if (phase !== null) flushPending(draft, phase, now);
};

// Streamed text and thinking blocks arrive again in order as assistant messages, so only those beyond the streamed count are new.
const consumeStreamedBlock = (draft: Draft, messageId: string) => {
  const counts = draft.blockCounts[messageId] ?? { streamed: 0, seen: 0 };
  draft.blockCounts[messageId] = { ...counts, seen: counts.seen + 1 };
  return counts.seen < counts.streamed;
};

const renderWholeBlock = (
  draft: Draft,
  block:
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string },
  now: number,
) => {
  if (block.type === "text") {
    const id = nextItemId(draft);
    itemStarted(draft, agentMessage(id, "", null), now);
    draft.pendingTexts.push({ kind: "text", id, text: block.text });
  } else {
    const item = reasoning(nextItemId(draft), block.thinking);
    itemStarted(draft, reasoning(item.id, ""), now);
    itemCompleted(draft, item, now);
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
  draft.tools[block.id] = { state: "running", item, startedAtMs: now };
  itemStarted(draft, item, now);
};

const renderToolResults = (
  draft: Draft,
  message: SDKUserMessage,
  now: number,
) => {
  const { content } = message.message;
  if (typeof content === "string") return;
  // The structured output belongs to a single tool, so it is used only when the message answers one call.
  const single =
    content.filter((block) => block.type === "tool_result").length === 1;
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const tool = draft.tools[block.tool_use_id];
    if (tool?.state !== "running") continue;
    const item = completeToolItem(tool.item, {
      content: block.content,
      isError: block.is_error === true,
      declined: draft.declinedToolUseIds.includes(block.tool_use_id),
      output: single ? message.tool_use_result : undefined,
      durationMs: now - tool.startedAtMs,
    });
    draft.tools[block.tool_use_id] =
      item.status === "failed"
        ? { state: "failed", item }
        : { state: "closed" };
    itemCompleted(draft, item, now);
  }
};

// Path deny rules and hook denials reach the host only in the result, after their items closed as failed, so those items are completed again as declined; the app keeps the latest completion of an item id.
const correctDenials = (draft: Draft, toolUseIds: string[], now: number) => {
  for (const toolUseId of toolUseIds) {
    draft.declinedToolUseIds.push(toolUseId);
    const tool = draft.tools[toolUseId];
    const declined =
      tool?.state === "failed" ? declineToolItem(tool.item) : null;
    if (declined !== null) itemCompleted(draft, declined, now);
  }
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
  closeBlocks(draft, now);
  flushPending(draft, completed ? "final_answer" : null, now);
  for (const [toolUseId, tool] of Object.entries(draft.tools)) {
    if (tool.state !== "running") continue;
    const declined = draft.declinedToolUseIds.includes(toolUseId)
      ? declineToolItem(tool.item)
      : null;
    draft.tools[toolUseId] = { state: "closed" };
    itemCompleted(draft, declined ?? abandonToolItem(tool.item), now);
  }
  const error: TurnError | null =
    outcome.status === "failed"
      ? {
          message: outcome.message,
          codexErrorInfo: null,
          additionalDetails: null,
          misalignment: null,
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
  notification: AppNotificationBody,
) => {
  draft.notifications.push({ ...notification, emittedAtMs: now });
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
  openBlocks: { ...state.openBlocks },
  pendingTexts: [...state.pendingTexts],
  blockCounts: { ...state.blockCounts },
  tools: { ...state.tools },
  declinedToolUseIds: [...state.declinedToolUseIds],
  notifications: [],
});

const seal = ({ notifications, ...state }: Draft): Rendered => ({
  state,
  notifications,
});

const toSeconds = (ms: number) => Math.floor(ms / 1000);

const CONTINUING_STOP_REASONS = new Set(["tool_use", "pause_turn"]);
