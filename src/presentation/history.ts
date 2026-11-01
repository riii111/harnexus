import type {
  SDKAssistantMessage,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import type {
  AppNotification,
  FileChangeItem,
  ThreadItem,
  Turn,
  UserInput,
} from "./protocol.ts";
import {
  inProgressTurn,
  itemCompletedAt,
  itemStartedAt,
  subagentActivityItem,
} from "./protocol-values.ts";
import { RECOVERY_CONTEXT, RECOVERY_NOTICE } from "./recovery.ts";
import {
  AGENT_TOOLS,
  closeTurnUnchecked,
  type Rendered,
  renderNotice,
  renderSdkMessage,
  renderTurnStarted,
  renderUserInput,
  type TurnState,
} from "./turn.ts";

// turn.items holds the summary a live turn/completed carries; the full items are kept apart for the pages that ask for them.
export type HistoryTurn = { turn: Turn; items: HistoryItem[] };

export type HistoryItem = {
  turnId: string;
  item: ThreadItem;
  startedAtMs: number | null;
  completedAtMs: number | null;
};

// Rebuilds a thread's turns from Claude's record through the live turn renderer, as the turns showed while they ran.
export const buildHistory = (
  messages: readonly SessionMessage[],
  thread: { threadId: string; cwd: string },
  agentThreadOf: (toolUseId: string) => AgentRef | undefined = () => undefined,
): HistoryTurn[] => {
  const turns: HistoryTurn[] = [];
  let replay: Replay | null = null;
  for (const message of messages) {
    // Claude records the tools a subagent called apart from the conversation.
    if (message.parent_tool_use_id !== null || isMetaMessage(message)) continue;
    const at = timeOf(message);
    const body = message.message;
    if (message.type === "user") {
      const prompt = promptOf(body);
      if (prompt === null) {
        if (replay !== null) {
          replay = feed(replay, toolResultsOf(message, body), at);
        }
      } else if (INTERRUPTED.test(prompt.text)) {
        if (replay !== null) replay = interrupt(replay);
      } else if (!LOCAL_COMMAND.test(prompt.text)) {
        // Each prompt opens a turn, so a steer taken mid-turn appears as a turn of its own.
        if (replay !== null) turns.push(close(replay));
        replay = start(thread, message.uuid, prompt, at);
      }
    } else if (message.type === "assistant" && isAssistantBody(body)) {
      replay ??= start(thread, message.uuid, null, at);
      replay = feed(replay, assistantOf(message, body), at);
      // An agent the conversation started or resumed shows where each of its calls was made, as the activity and edits a live turn gave it.
      replay = noteAgents(replay, body, agentThreadOf, at);
    }
  }
  if (replay !== null) turns.push(close(replay));
  return turns;
};

export const mainRecords = (messages: readonly SessionMessage[]) =>
  // A subagent's records and hidden ones such as a compact summary are left out, as history leaves them out.
  messages.filter(
    (message) =>
      message.parent_tool_use_id === null &&
      !isMetaMessage(message) &&
      (message.type === "user" || message.type === "assistant"),
  );

export const turnOpeningTextOf = (message: SessionMessage) => {
  if (message.type !== "user") return null;
  const prompt = promptOf(message.message);
  return prompt !== null && opensTurn(prompt) ? prompt.text : null;
};

const opensTurn = (prompt: Prompt) =>
  !INTERRUPTED.test(prompt.text) && !LOCAL_COMMAND.test(prompt.text);

export const endsTurn = (message: SessionMessage) =>
  message.type === "assistant" &&
  isObject(message.message) &&
  message.message.stop_reason === "end_turn";

// Renders records as they are copied, such as a Cloud thread's, as the live turn renders Claude's messages.
export const renderRecords = (
  state: TurnState,
  messages: readonly SessionMessage[],
  now: number,
): Rendered => {
  let current = state;
  const notifications: Rendered["notifications"] = [];
  const add = (next: Rendered) => {
    current = next.state;
    notifications.push(...next.notifications);
  };
  for (const message of messages) {
    const at = timeOf(message) ?? now;
    const body = message.message;
    if (message.type === "user") {
      const prompt = promptOf(body);
      if (prompt === null) {
        add(renderSdkMessage(current, toolResultsOf(message, body), at));
      } else if (opensTurn(prompt)) {
        // A prompt typed elsewhere is shown as the user's message.
        add(renderUserInput(current, inputOf(prompt), null, at));
      }
    } else if (isAssistantBody(body)) {
      add(renderSdkMessage(current, assistantOf(message, body), at));
    }
  }
  return { state: current, notifications };
};

export type LiveTurn = {
  turnId: string;
  record: string | null;
  startedAtMs: number;
};

export const withLiveTurn = (
  history: readonly HistoryTurn[],
  live: LiveTurn | null,
): HistoryTurn[] => {
  if (live === null) return [...history];
  // A record says nothing of a turn still running, so the turns from its prompt on, steers included, are shown as one turn in progress under the id the live notifications carry.
  const opened =
    live.record === null
      ? -1
      : history.findIndex(
          (entry) => entry.turn.id === `${HISTORY_TURN_PREFIX}${live.record}`,
        );
  const first = history[opened];
  // A turn not yet recorded, one Claude started itself without a prompt, or one a rewind cut off is shown empty.
  if (first === undefined) {
    return [
      ...history,
      {
        turn: inProgressTurn(live.turnId, live.startedAtMs, "summary"),
        items: [],
      },
    ];
  }
  return [
    ...history.slice(0, opened),
    {
      turn: {
        ...first.turn,
        id: live.turnId,
        rootTurnId: live.turnId,
        items: [],
        status: "inProgress",
        error: null,
        completedAt: null,
        durationMs: null,
      },
      items: history
        .slice(opened)
        .flatMap((entry) => entry.items)
        .map((entry) => ({ ...entry, turnId: live.turnId })),
    },
  ];
};

// The notifications that stream history into a thread the app already holds as finished turns, with the ids a later read rebuilds.
export const replayHistory = (
  history: readonly HistoryTurn[],
  threadId: string,
  now: number,
): AppNotification[] =>
  history.flatMap(({ turn, items }): AppNotification[] => {
    const startedAtMs = turn.startedAt === null ? now : turn.startedAt * 1000;
    const completedAtMs =
      turn.completedAt === null ? now : turn.completedAt * 1000;
    const ref = { threadId, turnId: turn.id };
    return [
      {
        method: "turn/started",
        params: {
          threadId,
          turn: {
            ...turn,
            items: [],
            itemsView: "full",
            status: "inProgress",
            completedAt: null,
            durationMs: null,
          },
        },
        emittedAtMs: startedAtMs,
      },
      ...items.flatMap(
        ({
          item,
          startedAtMs: itemStarted,
          completedAtMs: itemCompleted,
        }): AppNotification[] => [
          itemStartedAt(item, ref, itemStarted ?? startedAtMs),
          itemCompletedAt(item, ref, itemCompleted ?? completedAtMs),
        ],
      ),
      {
        method: "turn/completed",
        params: { threadId, turn },
        emittedAtMs: completedAtMs,
      },
    ];
  });

export const buildSubagentHistory = (
  messages: readonly SessionMessage[],
  thread: { threadId: string; cwd: string },
  agentThreadOf: (toolUseId: string) => AgentRef | undefined,
): HistoryTurn[] =>
  buildHistory(
    // A subagent's record is its own conversation, whose messages name the call that started the agent as their parent.
    messages.map((message) => ({ ...message, parent_tool_use_id: null })),
    thread,
    agentThreadOf,
  );

export type AgentRef = {
  threadId: string;
  path: string;
  active: boolean;
  edits: readonly FileChangeItem[];
};

export const delegatedEditIn = (
  edit: FileChangeItem,
  turnId: string,
): FileChangeItem => ({
  ...edit,
  // Agents that resume each other can pass one edit to several turns of a thread, and the app pages items by id.
  id: `${edit.id}-in-${turnId}`,
});

const noteAgents = (
  replay: Replay,
  body: SDKAssistantMessage["message"],
  agentThreadOf: (toolUseId: string) => AgentRef | undefined,
  at: number | null,
): Replay => {
  for (const block of body.content) {
    if (
      block.type !== "tool_use" ||
      !(AGENT_TOOLS.includes(block.name) || block.name === RESUME_TOOL)
    ) {
      continue;
    }
    const agent = agentThreadOf(block.id);
    if (agent === undefined) continue;
    const items: ThreadItem[] = [
      subagentActivityItem(agent, "started", block.id),
      ...agent.edits.map((edit) => delegatedEditIn(edit, replay.state.turnId)),
      ...(agent.active
        ? []
        : [subagentActivityItem(agent, "completed", block.id)]),
    ];
    for (const item of items) {
      replay.items.set(item.id, {
        turnId: replay.state.turnId,
        item,
        startedAtMs: at,
        completedAtMs: at,
      });
    }
  }
  return replay;
};

// Claude resumes an agent that has ended when a SendMessage call addresses it, and the agent runs under that call.
const RESUME_TOOL = "SendMessage";

export type AgentResume = {
  toolUseId: string;
  recipient: string;
  resumedAgentId: string | null;
  at: number | null;
};

// The calls in a record that resumed an agent.
export const findAgentResumes = (
  messages: readonly SessionMessage[],
): AgentResume[] => {
  const calls: Omit<AgentResume, "resumedAgentId">[] = [];
  const answers = new Map<string, unknown>();
  for (const message of messages) {
    if (isMetaMessage(message)) continue;
    const body = message.message;
    if (!isObject(body) || !Array.isArray(body.content)) continue;
    for (const block of body.content) {
      if (!isObject(block)) continue;
      if (
        message.type === "assistant" &&
        block.type === "tool_use" &&
        block.name === RESUME_TOOL &&
        typeof block.id === "string"
      ) {
        const recipient = recipientOf(block.input);
        if (recipient !== null) {
          calls.push({ toolUseId: block.id, recipient, at: timeOf(message) });
        }
      } else if (
        message.type === "user" &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        block.is_error !== true
      ) {
        answers.set(block.tool_use_id, resumeAnswer(block.content));
      }
    }
  }
  // Only Claude's answer tells a resume from a message queued for an agent still running.
  return calls.flatMap((call) => {
    const answer = answers.get(call.toolUseId);
    if (!isObject(answer)) return [];
    return [
      {
        ...call,
        resumedAgentId:
          typeof answer.resumedAgentId === "string"
            ? answer.resumedAgentId
            : null,
      },
    ];
  });
};

const recipientOf = (input: unknown) => {
  if (!isObject(input)) return null;
  // recipient is the older shape Claude still takes.
  const to = typeof input.to === "string" ? input.to : input.recipient;
  return typeof to === "string" && to !== "" ? to : null;
};

const resumeAnswer = (content: unknown) => {
  const first = Array.isArray(content)
    ? content.find((block) => isObject(block) && block.type === "text")
    : { text: content };
  const text =
    isObject(first) && typeof first.text === "string" ? first.text : "";
  // Claude's answer opens with one line of JSON, which a report handed back with it follows.
  const answer = parseLine(text.split("\n", 1)[0] ?? "");
  if (!isObject(answer) || answer.success !== true) return null;
  // The answer names the agent as resumedAgentId, or, when the agent's report comes back in it or the agent answers to another agent, says it is resuming or resumed the agent.
  return typeof answer.resumedAgentId === "string" ||
    (typeof answer.message === "string" && RESUMED.test(answer.message))
    ? answer
    : null;
};

const parseLine = (line: string): unknown => {
  const parsed = parseJson(line);
  return parsed.isOk() ? parsed.value : null;
};

const RESUMED = /^Resum(?:ed|ing) agent\b/;

type Replay = {
  state: TurnState;
  items: Map<string, HistoryItem>;
  interrupted: boolean;
  firstAt: number | null;
  lastAt: number | null;
};

const interrupt = (replay: Replay): Replay => ({
  ...replay,
  interrupted: true,
});

const start = (
  thread: { threadId: string; cwd: string },
  uuid: string,
  prompt: Prompt | null,
  at: number | null,
): Replay => {
  const opened = renderTurnStarted({
    threadId: thread.threadId,
    // A record keeps no bridge turn ids, so turn ids are made from the prompt's record uuid.
    turnId: `${HISTORY_TURN_PREFIX}${uuid}`,
    cwd: thread.cwd,
    now: at ?? 0,
  });
  const replay = collect(
    {
      state: opened.state,
      items: new Map(),
      interrupted: false,
      firstAt: at,
      lastAt: at,
    },
    opened,
  );
  if (prompt === null) return replay;
  const shown = collect(
    replay,
    renderUserInput(replay.state, inputOf(prompt), null, at ?? 0),
  );
  return prompt.recovering
    ? collect(
        shown,
        renderNotice(shown.state, RECOVERY_NOTICE, "commentary", at ?? 0),
      )
    : shown;
};

const feed = (
  replay: Replay,
  message: SDKUserMessage | SDKAssistantMessage,
  at: number | null,
): Replay => {
  const timed = {
    ...replay,
    firstAt: replay.firstAt ?? at,
    lastAt: at ?? replay.lastAt,
  };
  return collect(
    timed,
    renderSdkMessage(timed.state, message, timed.lastAt ?? 0),
  );
};

const close = (replay: Replay): HistoryTurn => {
  const closed = closeTurnUnchecked(
    replay.state,
    // A record says nothing of how its last turn ended unless an interrupt was written, so the rest close as completed.
    { status: replay.interrupted ? "interrupted" : "completed" },
    replay.lastAt ?? 0,
  );
  const { items } = collect(replay, closed);
  const untimed = replay.firstAt === null;
  return {
    turn: untimed
      ? { ...closed.turn, startedAt: null, completedAt: null, durationMs: null }
      : closed.turn,
    items: [...items.values()].map((entry) =>
      untimed ? { ...entry, startedAtMs: null, completedAtMs: null } : entry,
    ),
  };
};

const collect = (replay: Replay, rendered: Rendered): Replay => {
  noteItems(replay.items, rendered.notifications);
  return { ...replay, state: rendered.state };
};

export const noteItems = (
  items: Map<string, HistoryItem>,
  notifications: readonly AppNotification[],
) => {
  for (const notification of notifications) noteItem(items, notification);
};

export const noteItem = (
  items: Map<string, HistoryItem>,
  notification: AppNotification,
) => {
  // A completion replaces the item it closes, since the renderer may complete one item twice to correct a denial.
  if (notification.method === "item/started") {
    items.set(notification.params.item.id, {
      turnId: notification.params.turnId,
      item: notification.params.item,
      startedAtMs: notification.params.startedAtMs,
      completedAtMs: null,
    });
  } else if (notification.method === "item/completed") {
    const { item, turnId, completedAtMs } = notification.params;
    items.set(item.id, {
      turnId,
      item,
      startedAtMs: items.get(item.id)?.startedAtMs ?? completedAtMs,
      completedAtMs,
    });
  } else if (notification.method === "item/agentMessage/delta") {
    // The app can read a running turn while its text streams, so a started item takes in the text sent so far.
    const { itemId, delta } = notification.params;
    updateOpenItem(items, itemId, (item) =>
      item.type === "agentMessage"
        ? { ...item, text: item.text + delta }
        : item,
    );
  } else if (notification.method === "item/reasoning/textDelta") {
    const { itemId, delta, contentIndex } = notification.params;
    updateOpenItem(items, itemId, (item) => {
      if (item.type !== "reasoning") return item;
      const content = [...item.content];
      content[contentIndex] = (content[contentIndex] ?? "") + delta;
      return { ...item, content };
    });
  }
};

const updateOpenItem = (
  items: Map<string, HistoryItem>,
  itemId: string,
  update: (item: ThreadItem) => ThreadItem,
) => {
  const entry = items.get(itemId);
  if (entry === undefined || entry.completedAtMs !== null) return;
  items.set(itemId, { ...entry, item: update(entry.item) });
};

type Prompt = { text: string; images: UserInput[]; recovering?: boolean };

const inputOf = (prompt: Prompt): UserInput[] => [
  // An image sent alone has no text to show beside it.
  ...(prompt.text === "" && prompt.images.length > 0
    ? []
    : [{ type: "text", text: prompt.text, text_elements: [] }]),
  ...prompt.images,
];

// The prompt a user record holds, or null for one carrying tool results, which continues the turn.
const promptOf = (body: unknown): Prompt | null => {
  if (!isObject(body)) return null;
  const { content } = body;
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return null;
  if (
    content.some((block) => isObject(block) && block.type === "tool_result")
  ) {
    return null;
  }
  // The first text block is what was typed; later ones are files the bridge attached.
  const typed = content.find(
    (block) =>
      isObject(block) &&
      block.type === "text" &&
      block.text !== RECOVERY_CONTEXT,
  );
  return {
    text: isObject(typed) && typeof typed.text === "string" ? typed.text : "",
    recovering: content.some(
      (block) =>
        isObject(block) &&
        block.type === "text" &&
        block.text === RECOVERY_CONTEXT,
    ),
    // The file an attached image came from may be gone, so the image is shown from the copy Claude recorded.
    images: content.flatMap((block) => {
      const url = imageUrlOf(block);
      return url === null ? [] : [{ type: "image", url }];
    }),
  };
};

const imageUrlOf = (block: unknown) => {
  if (!isObject(block) || block.type !== "image") return null;
  const { source } = block;
  if (!isObject(source)) return null;
  if (
    source.type === "base64" &&
    typeof source.media_type === "string" &&
    typeof source.data === "string"
  ) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return source.type === "url" && typeof source.url === "string"
    ? source.url
    : null;
};

const isAssistantBody = (
  body: unknown,
): body is SDKAssistantMessage["message"] =>
  // The SDK types a record's message as unknown, so only a message with the fields the renderer reads is replayed.
  isObject(body) && typeof body.id === "string" && Array.isArray(body.content);

const assistantOf = (
  message: SessionMessage,
  body: SDKAssistantMessage["message"],
): SDKAssistantMessage => ({
  type: "assistant",
  message: body,
  parent_tool_use_id: null,
  uuid: message.uuid as SDKAssistantMessage["uuid"],
  session_id: message.session_id,
});

const toolResultsOf = (
  message: SessionMessage,
  body: unknown,
): SDKUserMessage => ({
  type: "user",
  // A user record without a prompt carries tool results.
  message: body as SDKUserMessage["message"],
  parent_tool_use_id: null,
  session_id: message.session_id,
});

const isMetaMessage = (message: SessionMessage) =>
  // The SDK returns these fields without typing them; a compact summary and other hidden records carry is_meta.
  (message as { is_meta?: unknown }).is_meta === true;

export const startOfRecord = (messages: readonly SessionMessage[]) => {
  for (const message of messages) {
    const at = timeOf(message);
    if (at !== null) return at;
  }
  return null;
};

export const timeOf = (message: SessionMessage) => {
  const stamp = (message as { timestamp?: unknown }).timestamp;
  const ms = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
};

const HISTORY_TURN_PREFIX = "harnexus-history-";

export const historyTurnId = (record: string) =>
  `${HISTORY_TURN_PREFIX}${record}`;

// Claude Code writes these as user messages when a turn is stopped.
const INTERRUPTED = /^\[Request interrupted by user/;

// A slash command such as /compact is recorded as its command, caveat and output rather than as a prompt Claude answered.
const LOCAL_COMMAND =
  /^<(command-name|local-command-stdout|local-command-caveat)>/;
