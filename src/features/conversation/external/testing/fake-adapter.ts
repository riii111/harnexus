import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import type { AppNotification } from "../../../../infra/codex/protocol/messages.ts";
import type {
  ConversationBinding,
  CreateIntent,
  ExternalConversationState,
} from "../../../../infra/external-conversations.ts";
import type {
  RunningTurn,
  TurnInput,
  TurnRuntime,
} from "../../turn/turn-runtime.ts";
import {
  markInterrupting,
  type Rendered,
  renderTurnStarted,
  type TurnOutcome,
  type TurnState,
} from "../../turn/turn.view.ts";
import {
  createExternalConversations,
  type ExternalLogEvent,
  type SpawnAdapter,
} from "../conversations.ts";

type Line = Record<string, unknown>;

// One run of the adapter process: what the bridge wrote to it, and how to answer or end it.
export type FakeProcess = {
  sent: Line[];
  alive: boolean;
  stopped: boolean;
  say: (message: Line) => void;
  sayRaw: (line: string) => void;
  exit: () => void;
  events: (event: string) => Line[];
  responses: () => Line[];
};

export const fakeAdapterProcesses = () => {
  const processes: FakeProcess[] = [];
  const spawn: SpawnAdapter = ({ onLine, onExit }) => {
    const process: FakeProcess = {
      sent: [],
      alive: true,
      stopped: false,
      say: (message) => onLine(JSON.stringify({ v: 1, ...message })),
      sayRaw: (line) => onLine(line),
      exit: () => {
        if (!process.alive) return;
        process.alive = false;
        onExit();
      },
      events: (event) =>
        process.sent.filter(
          (line) => line.type === "event" && line.event === event,
        ),
      responses: () => process.sent.filter((line) => line.type === "response"),
    };
    processes.push(process);
    return {
      send: (line) => {
        if (!process.alive) return false;
        process.sent.push(JSON.parse(line) as Line);
        return true;
      },
      stop: () => {
        process.stopped = true;
        process.exit();
      },
    };
  };

  // A test asks only after the adapter was started.
  const latest = () => processes[processes.length - 1] as FakeProcess;
  return { processes, spawn, latest };
};

// Timers that run only when a test runs them, oldest first.
export const manualTimers = () => {
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    timers,
    schedule: (run: () => void, ms: number) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    runAll: () => {
      const due = timers.splice(0).filter((timer) => !timer.cancelled);
      for (const timer of due) timer.run();
    },
  };
};

export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

export type GatewayCall = {
  threadId: string;
  tool: string;
  arguments: Record<string, unknown>;
};

// A bridge's conversations with a fake adapter, a fake call gateway and a saved state kept in memory.
export const externalEnv = ({
  mode = "write",
  bridgeId = "bridge-1",
  adapterId = "taskctl",
  state = { bindings: [], intents: [] } as ExternalConversationState | null,
  callers = ["parent-1"],
  owners = {} as Record<string, string>,
  conversationsHeld = [] as string[],
}: {
  mode?: "observe" | "write";
  bridgeId?: string;
  adapterId?: string;
  state?: ExternalConversationState | null;
  callers?: string[];
  owners?: Record<string, string>;
  conversationsHeld?: string[];
} = {}) => {
  const adapter = fakeAdapterProcesses();
  const timers = manualTimers();
  const saved: ExternalConversationState[] = [];
  const calls: GatewayCall[] = [];
  const sends: { sessionId: string; text: string }[] = [];
  const logs: ExternalLogEvent[] = [];
  const ownStarts: string[] = [];
  let ids = 0;
  const env = {
    adapter,
    timers,
    saved,
    calls,
    sends,
    logs,
    ownStarts,
    saveFails: false,
    sendAnswer: { outcome: "done" } as {
      outcome: "done" | "rejected" | "unknown";
      message?: string;
    },
    // Answers each gateway call; a test may hold it to run a first turn first.
    answer: async (_call: GatewayCall): Promise<Line> => ({
      outcome: "done",
      result: {},
    }),
    startOwnTurn: (threadId: string) => {
      ownStarts.push(threadId);
      return true;
    },
    lastSaved: (): ExternalConversationState | undefined => saved.at(-1),
  };
  const conversations = createExternalConversations({
    adapterId,
    mode,
    bridgeId,
    spawn: adapter.spawn,
    state,
    save: async (next) => {
      if (env.saveFails) return false;
      saved.push({ bindings: [...next.bindings], intents: [...next.intents] });
      return true;
    },
    call: async (line) => {
      const call = JSON.parse(line) as GatewayCall;
      calls.push(call);
      return JSON.stringify({ version: 1, ...(await env.answer(call)) });
    },
    isCaller: (threadId) => callers.includes(threadId),
    holdsConversation: (threadId) => conversationsHeld.includes(threadId),
    cloudOwner: (sessionId) => owners[sessionId],
    sendToSession: async (sessionId, text) => {
      sends.push({ sessionId, text });
      return env.sendAnswer;
    },
    log: (event) => logs.push(event),
    schedule: timers.schedule,
    now: () => Date.parse("2026-11-06T00:00:00.000Z"),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
  conversations.listen((threadId) => env.startOwnTurn(threadId));
  return { ...env, env, conversations };
};

export const hello = (
  bindings: { conversationId: string; threadId: string }[] = [],
) => ({
  type: "hello",
  adapterId: "taskctl",
  bindings,
});

export const binding = (
  conversationId: string,
  threadId: string,
): ConversationBinding => ({ adapterId: "taskctl", conversationId, threadId });

export const intent = (
  intentId: string,
  conversationId: string,
  callerThreadId = "parent-1",
): CreateIntent => ({
  intentId,
  adapterId: "taskctl",
  conversationId,
  callerThreadId,
  createdAt: "2026-11-06T00:00:00.000Z",
});

export const records = (...uuids: string[]) =>
  uuids.map((uuid) => ({ uuid, type: "user" })) as unknown as SessionMessage[];

export const innerRuntime = (runs: string[]): TurnRuntime<string> => ({
  compactPrompt: "/compact",
  closeSession: () => {},
  pauseMessages: () => () => {},
  recordOf: () => null,
  run: async (turn) => {
    runs.push(turn.turnId);
    turn.finish({ status: "completed" }, null);
  },
  steer: async () => null,
  interrupt: () => {},
  dropSession: () => {},
  noteFork: async () => {},
  dropFork: () => {},
  forgetThread: () => {},
  threadBusy: () => {},
  threadIdle: () => {},
  listen: () => {},
  closeAll: () => {},
});

// A turn of the chat, typed in it, started by the bridge, or the first message another chat made it with.
export const fakeTurn = (
  turnId: string,
  {
    threadId = "chat-1",
    text = "",
    startedBy = "app",
    createdBy = null,
    images = [],
  }: {
    threadId?: string;
    text?: string;
    startedBy?: "app" | "claude";
    createdBy?: { source: string; prompt: string } | null;
    images?: readonly { path: string }[];
  } = {},
) => {
  let state: TurnState = renderTurnStarted({
    threadId,
    turnId,
    cwd: "/work/tree",
    now: 0,
  }).state;
  const notifications: AppNotification[] = [];
  const delegation =
    createdBy === null
      ? null
      : `<codex_delegation>\n  <source_thread_id>${createdBy.source}</source_thread_id>\n  <input>${createdBy.prompt}</input>\n</codex_delegation>`;
  const input: TurnInput = {
    items: delegation === null && text !== "" ? [{ type: "text", text }] : [],
    toolOutput:
      delegation === null
        ? null
        : { name: "create_thread", namespace: "codex_app", output: delegation },
    text: delegation ?? text,
    images: images as TurnInput["images"],
    tabCandidates: [],
    permissionMode: "default",
    effort: null,
    startedBy,
  };
  const result = {
    outcome: null as TurnOutcome | null,
    failure: null as { _tag: string; message: string } | null,
    running: undefined as unknown as RunningTurn<string>,
    texts: () =>
      notifications.flatMap((notification) =>
        notification.method === "item/completed" &&
        notification.params.item.type === "agentMessage"
          ? [notification.params.item.text]
          : [],
      ),
    stop: () => {
      state = markInterrupting(state);
    },
  };
  const apply = (rendered: Rendered) => {
    state = rendered.state;
    notifications.push(...rendered.notifications);
  };

  result.running = {
    threadId,
    turnId,
    record: {
      threadId,
      sessionId: null,
      model: "claude-sonnet-5-5",
      effort: null,
      worktree: "/work/tree",
      messageIds: [],
      runState: "running",
    },
    model: "claude-sonnet-5-5",
    input,
    compaction: false,
    startedAtMs: 0,
    state: () => state,
    apply,
    finish: (outcome) => {
      result.outcome = outcome;
    },
    fail: (error) => {
      result.failure = error;
    },
    markOutcomeUnknown: () => {},
    isOpen: () => result.outcome === null && result.failure === null,
    useLink: () => {},
    ask: async () => null,
  };
  return result;
};
