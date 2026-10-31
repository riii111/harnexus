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
  inProgressTurn,
  itemCompletedAt,
  itemStartedAt,
  toSeconds,
} from "./protocol-values.ts";
import {
  abandonToolItem,
  completeToolItem,
  declineToolItem,
  singleCallOutput,
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
  compactionRequested?: boolean;
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
    compaction: params.compactionRequested ?? false,
    compactionError: null,
    compacted: false,
  });
  const turn = inProgressTurn(params.turnId, params.now, "full");
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

// The answer to a turn/start that joins the running turn: that turn without its items, as Codex answers a steer.
export const steeredTurn = (state: TurnState): Turn =>
  inProgressTurn(state.turnId, state.startedAtMs, "notLoaded");

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

// Shows the bridge's own message, such as an answer to /session, as an agent message that never reaches Claude's record.
export const renderNotice = (
  state: TurnState,
  text: string,
  phase: "commentary" | "final_answer",
  now: number,
): Rendered => {
  if (state.finished) return { state, notifications: [] };
  const draft = open(state);
  const item = agentMessage(nextItemId(draft), text, phase);
  itemStarted(draft, agentMessage(item.id, "", null), now);
  completeMessage(draft, item, now);
  return seal(draft);
};

export const renderSdkMessage = (
  state: TurnState,
  message: SDKMessage,
  now: number,
): Rendered => {
  if (state.finished) return { state, notifications: [] };
  const draft = open(state);
  // A subagent's messages belong to its own thread, so only a result completing an item of this turn, such as a subagent's call asked about here, is taken from them.
  switch (message.type) {
    // A compaction's only text is the command's own report, which its outcome already carries.
    case "stream_event":
      if (message.parent_tool_use_id === null && !draft.compaction) {
        renderStreamEvent(draft, message.event, now);
      }
      break;
    case "assistant":
      if (message.parent_tool_use_id === null && !draft.compaction) {
        renderAssistant(draft, message, now);
      }
      break;
    case "user":
      if (!("isReplay" in message)) renderToolResults(draft, message, now);
      break;
    case "system":
      renderSystem(draft, message, now);
      break;
    case "result":
      correctDenials(
        draft,
        message.permission_denials.map((denial) => denial.tool_use_id),
        now,
      );
      finish(draft, resultOutcome(draft, message), now);
      break;
  }
  return seal(draft);
};

// Renders a result after which the app turn goes on, as when a steer Claude had not taken runs as its next turn.
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

export const renderTurnCompleted = (
  state: TurnState,
  outcome: TurnOutcome,
  now: number,
): Rendered => {
  if (state.finished) return { state, notifications: [] };
  return closeTurnUnchecked(state, outcome, now);
};

export const closeTurnUnchecked = (
  state: TurnState,
  outcome: TurnOutcome,
  now: number,
): Rendered & { turn: Turn } => {
  const draft = open(state);
  const turn = finish(draft, outcome, now);
  return { ...seal(draft), turn };
};

export const renderToolRequest = (
  state: TurnState,
  block: { id: string; name: string; input: unknown },
  now: number,
  closesText = true,
): Rendered => {
  if (state.finished) return { state, notifications: [] };
  const draft = open(state);
  // A permission request can reach the bridge before the message carrying its tool call, and the app's prompt points at the tool's item, so the item starts here; the later tool call is skipped as already started.
  startTool(draft, block, now, closesText);
  return seal(draft);
};

export const runsAgent = (state: TurnState) =>
  Object.values(state.tools).some(
    (tool) =>
      tool.state === "running" &&
      tool.item.type === "mcpToolCall" &&
      AGENT_TOOLS.includes(tool.item.tool),
  );

export const runningToolItem = (
  state: TurnState,
  toolUseId: string,
): ToolItem | null => {
  const tool = state.tools[toolUseId];
  return tool?.state === "running" ? tool.item : null;
};

export const markInterrupting = (state: TurnState): TurnState => ({
  ...state,
  interrupting: true,
});

export const markToolDeclined = (
  state: TurnState,
  toolUseId: string,
): TurnState =>
  // The permission callback refuses a tool without any SDK message saying so, so it reports the refusal here; the call may come before or after the tool item starts.
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
  compaction: boolean;
  compactionError: string | null;
  compacted: boolean;
  notifications: AppNotification[];
};

type OpenBlock = { kind: "text" | "reasoning"; id: string; text: string };

// A tool is tracked from its start to the end of the turn so it never starts twice; only a failed one keeps its item, which a later denial corrects, so large outputs are not held until the turn ends.
type TrackedTool =
  | { state: "running"; item: ToolItem; startedAtMs: number }
  | { state: "failed"; item: ToolItem }
  | { state: "closed" };

type SystemMessage = Extract<SDKMessage, { type: "system" }>;

type StreamEvent = SDKPartialAssistantMessage["event"];

type StreamDelta = Extract<
  StreamEvent,
  { type: "content_block_delta" }
>["delta"];

const renderSystem = (draft: Draft, message: SystemMessage, now: number) => {
  switch (message.subtype) {
    case "permission_denied":
      draft.declinedToolUseIds.push(message.tool_use_id);
      break;
    // Claude compacts on its own inside a turn as well as when the app asks, and both show the same item.
    case "compact_boundary":
      renderCompaction(draft, now);
      break;
    case "status":
      // Only a compaction the app asked for fails its turn, since after one Claude tried on its own the turn reports what followed.
      if (draft.compaction && message.compact_result === "failed") {
        draft.compactionError = message.compact_error ?? COMPACTION_FAILED;
      }
      break;
  }
};

const renderCompaction = (draft: Draft, now: number) => {
  const item: ThreadItem = { type: "contextCompaction", id: nextItemId(draft) };
  draft.compacted = true;
  // Claude reports a compaction only once it is done, so its item starts and completes together.
  itemStarted(draft, item, now);
  itemCompleted(draft, item, now);
  // thread/compacted is deprecated but still in the protocol for apps that read it.
  notify(draft, now, {
    method: "thread/compacted",
    params: { threadId: draft.threadId, turnId: draft.turnId },
  });
};

const renderStreamEvent = (draft: Draft, event: StreamEvent, now: number) => {
  switch (event.type) {
    case "message_start":
      // A retried or abandoned message may never send its block stops, so its blocks close when the next message starts.
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

const stopBlock = (draft: Draft, index: number, now: number) => {
  const block = draft.openBlocks[index];
  if (block === undefined) return;
  delete draft.openBlocks[index];
  // Whether a text block is commentary or the final answer is known only from the stop reason that follows it, so its completion waits.
  if (block.kind === "text") draft.pendingTexts.push(block);
  else itemCompleted(draft, reasoning(block.id, block.text), now);
};

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

const renderAssistant = (
  draft: Draft,
  message: SDKAssistantMessage,
  now: number,
) => {
  // An SDK-made API error message is skipped because the result reports the same error.
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
      // Without partial messages, or for a block the stream did not carry, the whole block arrives here at once.
      renderWholeBlock(draft, block, now);
    }
  }
  if (phase !== null) flushPending(draft, phase, now);
};

const consumeStreamedBlock = (draft: Draft, messageId: string) => {
  const counts = draft.blockCounts[messageId] ?? { streamed: 0, seen: 0 };
  draft.blockCounts[messageId] = { ...counts, seen: counts.seen + 1 };
  // Streamed text and thinking blocks arrive again in order as assistant messages, so only those beyond the streamed count are new.
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

const startTool = (
  draft: Draft,
  block: { id: string; name: string; input: unknown },
  now: number,
  closesText = true,
) => {
  if (draft.tools[block.id] !== undefined) return;
  // Text before a tool call is commentary, and closing it first keeps the app's items in the order Claude produced them.
  if (closesText) flushPending(draft, "commentary", now);
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
  const output = singleCallOutput(content, message.tool_use_result);
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const tool = draft.tools[block.tool_use_id];
    if (tool?.state !== "running") continue;
    const item = completeToolItem(tool.item, {
      content: block.content,
      isError: block.is_error === true,
      declined: draft.declinedToolUseIds.includes(block.tool_use_id),
      output,
      durationMs: now - tool.startedAtMs,
    });
    draft.tools[block.tool_use_id] =
      item.status === "failed"
        ? { state: "failed", item }
        : { state: "closed" };
    itemCompleted(draft, item, now);
  }
};

const correctDenials = (draft: Draft, toolUseIds: string[], now: number) => {
  for (const toolUseId of toolUseIds) {
    draft.declinedToolUseIds.push(toolUseId);
    const tool = draft.tools[toolUseId];
    // Path deny rules and hook denials reach the host only in the result, after their items closed as failed, so those items are completed again as declined; the app keeps the latest completion of an item id.
    const declined =
      tool?.state === "failed" ? declineToolItem(tool.item) : null;
    if (declined !== null) itemCompleted(draft, declined, now);
  }
};

const resultOutcome = (draft: Draft, result: SDKResultMessage): TurnOutcome => {
  // An interrupted SDK query still ends with a result, which must close the turn as interrupted rather than failed.
  if (draft.interrupting) return { status: "interrupted" };
  // The CLI ends a failed compaction with a successful result, so the failure its status reported decides the outcome.
  if (draft.compactionError !== null) {
    return { status: "failed", message: draft.compactionError };
  }
  const outcome = outcomeOf(result);
  // A compaction that reported neither its boundary nor a failure is not shown as done.
  return outcome.status === "completed" && draft.compaction && !draft.compacted
    ? { status: "failed", message: NOT_COMPACTED }
    : outcome;
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
  const turn: Turn = {
    ...inProgressTurn(draft.turnId, draft.startedAtMs, "summary"),
    items: completed && draft.finalMessage !== null ? [draft.finalMessage] : [],
    status: outcome.status,
    error,
    completedAt: toSeconds(now),
    durationMs: now - draft.startedAtMs,
  };
  notify(draft, now, {
    method: "turn/completed",
    params: { threadId: draft.threadId, turn },
  });
  draft.finished = true;
  return turn;
};

const completeMessage = (draft: Draft, item: AgentMessageItem, now: number) => {
  if (item.phase === "final_answer") draft.finalMessage = item;
  itemCompleted(draft, item, now);
};

const itemStarted = (draft: Draft, item: ThreadItem, now: number) => {
  draft.notifications.push(itemStartedAt(item, draft, now));
};

const itemCompleted = (draft: Draft, item: ThreadItem, now: number) => {
  draft.notifications.push(itemCompletedAt(item, draft, now));
};

const notify = (
  draft: Draft,
  now: number,
  notification: AppNotificationBody,
) => {
  draft.notifications.push({ ...notification, emittedAtMs: now });
};

const nextItemId = (draft: Draft) =>
  // Item ids only need to be unique within the thread, and the turn id already is.
  `${draft.turnId}-item-${draft.nextItem++}`;

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

const CONTINUING_STOP_REASONS = new Set(["tool_use", "pause_turn"]);

const COMPACTION_FAILED = "Claude could not compact the conversation";

const NOT_COMPACTED = "Claude did not compact the conversation";

// Claude Code names the tool that starts a subagent Agent, and older versions named it Task.
export const AGENT_TOOLS = ["Agent", "Task"];
