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
import { RECOVERY_CONTEXT, RECOVERY_NOTICE } from "./recovery.ts";
import {
  closeTurn,
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

// The record is replayed through the live turn renderer, so a reopened thread shows the same items the turn showed while it ran, except the tools a subagent called, which Claude records apart from the conversation.
// Each prompt opens a turn, so a steer taken mid-turn appears as a turn of its own, and a record keeps no bridge turn ids, so turn ids are made from the prompt's record uuid.
// An agent the conversation started or resumed shows where each of its calls was made, as the activity and edits a live turn gave it; agentThreadOf names the agent's thread for a call, if the bridge knows it.
export const buildHistory = (
  messages: readonly SessionMessage[],
  thread: { threadId: string; cwd: string },
  agentThreadOf: (toolUseId: string) => AgentRef | undefined = () => undefined,
): HistoryTurn[] => {
  const turns: HistoryTurn[] = [];
  let replay: Replay | null = null;
  for (const message of messages) {
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
        if (replay !== null) turns.push(close(replay));
        replay = start(thread, message.uuid, prompt, at);
      }
    } else if (message.type === "assistant" && isAssistantBody(body)) {
      replay ??= start(thread, message.uuid, null, at);
      replay = feed(replay, assistantOf(message, body), at);
      replay = noteAgents(replay, body, agentThreadOf, at);
    }
  }
  if (replay !== null) turns.push(close(replay));
  return turns;
};

// The turn the bridge is running on a thread, with the record of the prompt that opened it once Claude has written it.
export type LiveTurn = {
  turnId: string;
  record: string | null;
  startedAtMs: number;
};

// A record says nothing of a turn still running, so the turns from its prompt on, steers included, are shown as one turn in progress under the id the live notifications carry.
export const withLiveTurn = (
  history: readonly HistoryTurn[],
  live: LiveTurn | null,
): HistoryTurn[] => {
  if (live === null) return [...history];
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
        turn: {
          id: live.turnId,
          items: [],
          itemsView: "summary",
          status: "inProgress",
          error: null,
          startedAt: Math.floor(live.startedAtMs / 1000),
          completedAt: null,
          durationMs: null,
        },
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

// A thread the app already holds never asks for history it was given while open, so a picked conversation is streamed in as finished turns; the ids match what a later read rebuilds.
export const replayHistory = (
  history: readonly HistoryTurn[],
  threadId: string,
  now: number,
): AppNotification[] =>
  history.flatMap(({ turn, items }): AppNotification[] => {
    const startedAtMs = turn.startedAt === null ? now : turn.startedAt * 1000;
    const completedAtMs =
      turn.completedAt === null ? now : turn.completedAt * 1000;
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
          {
            method: "item/started",
            params: {
              item,
              threadId,
              turnId: turn.id,
              startedAtMs: itemStarted ?? startedAtMs,
            },
            emittedAtMs: itemStarted ?? startedAtMs,
          },
          {
            method: "item/completed",
            params: {
              item,
              threadId,
              turnId: turn.id,
              completedAtMs: itemCompleted ?? completedAtMs,
            },
            emittedAtMs: itemCompleted ?? completedAtMs,
          },
        ],
      ),
      {
        method: "turn/completed",
        params: { threadId, turn },
        emittedAtMs: completedAtMs,
      },
    ];
  });

// A subagent's record is its own conversation, whose messages name the call that started the agent as their parent.
export const buildSubagentHistory = (
  messages: readonly SessionMessage[],
  thread: { threadId: string; cwd: string },
  agentThreadOf: (toolUseId: string) => AgentRef | undefined,
): HistoryTurn[] =>
  buildHistory(
    messages.map((message) => ({ ...message, parent_tool_use_id: null })),
    thread,
    agentThreadOf,
  );

// active marks an agent still running under this call, which has not completed where the call was made.
export type AgentRef = {
  threadId: string;
  path: string;
  active: boolean;
  edits: readonly FileChangeItem[];
};

// Agents that resume each other can pass one edit to several turns of a thread, and the app pages items by id.
export const delegatedEditIn = (
  edit: FileChangeItem,
  turnId: string,
): FileChangeItem => ({ ...edit, id: `${edit.id}-in-${turnId}` });

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
    const activity = (kind: "started" | "completed"): ThreadItem => ({
      type: "subAgentActivity",
      id: `${agent.threadId}-${kind}-${block.id}`,
      kind,
      agentThreadId: agent.threadId,
      agentPath: agent.path,
    });
    const items = [
      activity("started"),
      ...agent.edits.map((edit) => delegatedEditIn(edit, replay.state.turnId)),
      ...(agent.active ? [] : [activity("completed")]),
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

// Claude Code names the tool that starts a subagent Agent, and older versions named it Task.
const AGENT_TOOLS = ["Agent", "Task"];

// Claude resumes an agent that has ended when a SendMessage call addresses it, and the agent runs under that call.
const RESUME_TOOL = "SendMessage";

// A SendMessage call that resumed an agent, naming it as the call did and, when Claude's answer says so, by its id.
export type AgentResume = {
  toolUseId: string;
  recipient: string;
  resumedAgentId: string | null;
  at: number | null;
};

// The calls in a record that resumed an agent: a SendMessage call addresses its recipient as to, or as recipient in the older shape Claude still takes, and only Claude's answer tells a resume from a message queued for an agent still running.
// Claude answers a resume with JSON naming the agent as resumedAgentId, or, when the agent's report comes back in the answer or the agent answers to another agent, with a message that it is resuming or resumed the agent.
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
  const to = typeof input.to === "string" ? input.to : input.recipient;
  return typeof to === "string" && to !== "" ? to : null;
};

// Claude's answer opens with one line of JSON, which a report handed back with it follows.
const resumeAnswer = (content: unknown) => {
  const first = Array.isArray(content)
    ? content.find((block) => isObject(block) && block.type === "text")
    : { text: content };
  const text =
    isObject(first) && typeof first.text === "string" ? first.text : "";
  const answer = parseLine(text.split("\n", 1)[0] ?? "");
  if (!isObject(answer) || answer.success !== true) return null;
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
  const input: UserInput[] = [
    ...(prompt.text === "" && prompt.images.length > 0
      ? []
      : [{ type: "text", text: prompt.text, text_elements: [] }]),
    ...prompt.images,
  ];
  const shown = collect(
    replay,
    renderUserInput(replay.state, input, null, at ?? 0),
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

// A record says nothing of how its last turn ended unless an interrupt was written, so the rest close as completed.
const close = (replay: Replay): HistoryTurn => {
  const closed = closeTurn(
    replay.state,
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

// A completion replaces the item it closes, since the renderer may complete one item twice to correct a denial.
const collect = (replay: Replay, rendered: Rendered): Replay => {
  const items = replay.items;
  for (const notification of rendered.notifications) {
    noteItem(items, notification);
  }
  return { ...replay, state: rendered.state, items };
};

// Shared with a subagent's thread, whose turns the bridge keeps as they run.
export const noteItem = (
  items: Map<string, HistoryItem>,
  notification: AppNotification,
) => {
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
  }
};

type Prompt = { text: string; images: UserInput[]; recovering?: boolean };

// A user record carrying tool results continues the turn; any other user record is a prompt, whose first text block is what was typed and whose later ones are files the bridge attached.
// The file an attached image came from may be gone, so the image is shown from the copy Claude recorded.
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

// The SDK types a record's message as unknown, so only a message with the fields the renderer reads is replayed.
const isAssistantBody = (
  body: unknown,
): body is SDKAssistantMessage["message"] =>
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

// promptOf has already found tool results in this content.
const toolResultsOf = (
  message: SessionMessage,
  body: unknown,
): SDKUserMessage => ({
  type: "user",
  message: body as SDKUserMessage["message"],
  parent_tool_use_id: null,
  session_id: message.session_id,
});

// The SDK returns these fields without typing them; a compact summary and other hidden records carry is_meta.
const isMetaMessage = (message: SessionMessage) =>
  (message as { is_meta?: unknown }).is_meta === true;

export const startOfRecord = (messages: readonly SessionMessage[]) => {
  for (const message of messages) {
    const at = timeOf(message);
    if (at !== null) return at;
  }
  return null;
};

const timeOf = (message: SessionMessage) => {
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
