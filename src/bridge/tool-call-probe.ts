import { parseJson } from "../boundary/json.ts";
import { createLineSplitter } from "../rpc/line-splitter.ts";
import type { Direction } from "../rpc/observe.ts";
import type { LogEvent } from "../shared/logger.ts";

export type ToolCallProbeEvent = {
  event: "tool_call_probe";
  step: ProbeStep;
  role: ThreadRole | null;
  detail: string | null;
};

type ProbeStep =
  | "thread_seen"
  | "call_sent"
  | "call_answered"
  | "turn_start_requested"
  | "turn_started"
  | "turn_completed"
  | "approval_requested"
  | "approval_answered";

// A is the first thread the app opens and B the second; only the role reaches the log, never the thread id.
type ThreadRole = "A" | "B";

export const TOOL_CALL_PROBE_ENV = "HARNEXUS_PROBE_TOOL_CALL";

// Diagnostic only: the call is made while A has no running turn, the situation of a Claude thread.
export const createToolCallProbe = (
  env: NodeJS.ProcessEnv,
  log: (entry: LogEvent) => void,
  { quietMs = QUIET_MS } = {},
) => {
  const mode = env[TOOL_CALL_PROBE_ENV];
  if (mode !== "read" && mode !== "send") return null;
  const threads: string[] = [];
  const active = new Set<string>();
  const approvals = new Map<string | number, ThreadRole | null>();
  let inject: ((line: string) => void) | null = null;
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const role = (threadId: unknown): ThreadRole | null =>
    threadId === threads[0] ? "A" : threadId === threads[1] ? "B" : null;
  const record = (
    step: ProbeStep,
    threadRole: ThreadRole | null,
    detail: string | null = null,
  ) => log({ event: "tool_call_probe", step, role: threadRole, detail });

  const schedule = () => {
    if (fired || inject === null) return;
    const caller = threads[0];
    if (caller === undefined || threads.length < (mode === "send" ? 2 : 1)) {
      return;
    }
    clearTimeout(timer);
    if (active.has(caller)) return;
    timer = setTimeout(() => fire(caller), quietMs);
  };

  const fire = (caller: string) => {
    if (fired || inject === null || active.has(caller)) return;
    fired = true;
    const [tool, args] =
      mode === "send"
        ? [
            "send_message_to_thread",
            { threadId: threads[1], prompt: replyPrompt(caller) },
          ]
        : ["list_projects", {}];
    inject(
      `${JSON.stringify({
        id: CALL_ID,
        method: "mcpServer/tool/call",
        params: {
          threadId: caller,
          server: "codex_app",
          tool,
          arguments: args,
        },
      })}\n`,
    );
    record("call_sent", "A", tool);
  };

  const onServerMessage = (message: Message) => {
    const threadId =
      message.result?.thread?.id ??
      (message.method === "thread/started"
        ? message.params?.thread?.id
        : undefined);
    if (
      typeof threadId === "string" &&
      threads.length < 2 &&
      !threads.includes(threadId)
    ) {
      threads.push(threadId);
      record("thread_seen", role(threadId));
    }
    const target = message.params?.threadId;
    if (message.method === "turn/started" && typeof target === "string") {
      active.add(target);
      if (role(target)) record("turn_started", role(target));
    }
    if (message.method === "turn/completed" && typeof target === "string") {
      active.delete(target);
      if (role(target)) record("turn_completed", role(target));
    }
    if (isApprovalRequest(message.method) && message.id !== undefined) {
      approvals.set(message.id, role(target));
      record("approval_requested", role(target), message.method ?? null);
    }
    schedule();
  };

  const onAppMessage = (message: Message) => {
    const target = message.params?.threadId;
    if (message.method === "turn/start" && role(target)) {
      record("turn_start_requested", role(target));
    }
    if (message.method === undefined && message.id !== undefined) {
      const approval = approvals.get(message.id);
      if (approval !== undefined) {
        approvals.delete(message.id);
        record("approval_answered", approval, answer(message.result));
      }
    }
  };

  const splitters = {
    app_to_server: messageSplitter(onAppMessage),
    server_to_app: messageSplitter(onServerMessage),
  };

  return {
    attach: (injectLine: (line: string) => void) => {
      inject = injectLine;
      schedule();
    },
    observer: {
      chunk: (direction: Direction, chunk: Uint8Array) =>
        splitters[direction].push(chunk),
      end: (direction: Direction) => splitters[direction].end(),
    },
    isOwnResponse: (line: Buffer) =>
      line.includes(CALL_ID_BYTES) && !line.includes(METHOD_KEY_BYTES),
    onOwnResponse: (line: Buffer) => {
      const parsed = parseJson(line.toString());
      const message = parsed.isOk() ? (parsed.value as Message) : {};
      const outcome =
        message.error !== undefined
          ? "rpc_error"
          : message.result?.isError === true
            ? "tool_error"
            : "ok";
      record("call_answered", "A", outcome);
    },
  };
};

const messageSplitter = (onMessage: (message: Message) => void) =>
  createLineSplitter(MAX_LINE_BYTES, (line) => {
    if (line.kind !== "line") return;
    const parsed = parseJson(Buffer.from(line.bytes).toString());
    if (parsed.isOk() && typeof parsed.value === "object" && parsed.value) {
      onMessage(parsed.value as Message);
    }
  });

const isApprovalRequest = (method: string | undefined) =>
  method === "mcpServer/elicitation/request" ||
  (method?.endsWith("/requestApproval") ?? false);

// Only fixed decision words are logged, never form content.
const answer = (result: Message["result"]) => {
  const value = result?.action ?? result?.decision;
  return typeof value === "string" && DECISIONS.has(value) ? value : "other";
};

const replyPrompt = (caller: string) =>
  `This message comes from a harnexus connectivity check. Reply to thread ${caller} with send_message_to_thread and the single word ok, then stop without using other tools.`;

type Message = {
  id?: string | number;
  method?: string;
  params?: { threadId?: unknown; thread?: { id?: unknown } };
  result?: {
    thread?: { id?: unknown };
    isError?: unknown;
    action?: unknown;
    decision?: unknown;
  };
  error?: unknown;
};

const CALL_ID = "harnexus-probe-1";
const CALL_ID_BYTES = Buffer.from(`"id":"${CALL_ID}"`);
const METHOD_KEY_BYTES = Buffer.from('"method":');
const DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const QUIET_MS = 15_000;
