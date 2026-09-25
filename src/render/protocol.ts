// The subset of the app-server protocol the bridge emits for a Claude turn; shapes follow `test/fixtures/app-server/`.

export type AppNotification =
  | Envelope<
      "thread/status/changed",
      { threadId: string; status: ThreadStatus }
    >
  | Envelope<"turn/started", { threadId: string; turn: Turn }>
  | Envelope<"turn/completed", { threadId: string; turn: Turn }>
  | Envelope<"item/started", ItemParams & { startedAtMs: number }>
  | Envelope<"item/completed", ItemParams & { completedAtMs: number }>
  | Envelope<"item/agentMessage/delta", DeltaParams>
  | Envelope<"item/reasoning/textDelta", DeltaParams & { contentIndex: number }>
  | Envelope<
      "error",
      { error: TurnError; willRetry: boolean; threadId: string; turnId: string }
    >;

export type Turn = {
  id: string;
  items: ThreadItem[];
  itemsView: "full" | "summary";
  status: "inProgress" | "completed" | "failed" | "interrupted";
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
};

export type TurnError = {
  message: string;
  codexErrorInfo: null;
  additionalDetails: string | null;
};

// App input is passed back unchanged, so only the discriminator is typed.
export type UserInput = { type: string } & Record<string, unknown>;

export type ThreadItem =
  | {
      type: "userMessage";
      id: string;
      clientId: string | null;
      content: UserInput[];
    }
  | AgentMessageItem
  | ReasoningItem
  | ToolItem;

export type AgentMessageItem = {
  type: "agentMessage";
  id: string;
  text: string;
  phase: "commentary" | "final_answer" | null;
  memoryCitation: null;
  delivery: null;
  questions: null;
};

type ReasoningItem = {
  type: "reasoning";
  id: string;
  summary: string[];
  content: string[];
};

export type ToolItem = CommandExecutionItem | FileChangeItem | McpToolCallItem;

export type CommandExecutionItem = {
  type: "commandExecution";
  id: string;
  pluginId: null;
  scriptPath: null;
  command: string;
  cwd: string;
  processId: null;
  source: "agent";
  status: "inProgress" | "completed" | "failed" | "declined";
  commandActions: { type: "unknown"; command: string }[];
  aggregatedOutput: string | null;
  exitCode: number | null;
  durationMs: number | null;
};

export type FileChangeItem = {
  type: "fileChange";
  id: string;
  changes: FileUpdateChange[];
  status: "inProgress" | "completed" | "failed" | "declined";
};

export type FileUpdateChange = {
  path: string;
  kind: { type: "add" } | { type: "update"; move_path: null };
  diff: string;
};

export type McpToolCallItem = {
  type: "mcpToolCall";
  id: string;
  server: string;
  tool: string;
  status: "inProgress" | "completed" | "failed";
  arguments: unknown;
  appContext: null;
  pluginId: null;
  readOnlyHint: null;
  result: { content: unknown[]; structuredContent: null; _meta: null } | null;
  error: { message: string } | null;
  durationMs: number | null;
};

type ThreadStatus = { type: "idle" } | { type: "active"; activeFlags: never[] };

type Envelope<M extends string, P> = {
  method: M;
  params: P;
  emittedAtMs: number;
};

type ItemParams = { item: ThreadItem; threadId: string; turnId: string };

type DeltaParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
};
