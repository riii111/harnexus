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
  | "refused"
  | "thread_seen"
  | "call_sent"
  | "call_answered"
  | "turn_start_requested"
  | "turn_started"
  | "turn_completed"
  | "approval_requested"
  | "approval_answered";

// A is the caller and B the recipient named by the environment; only the role reaches the log, never the thread id.
type ThreadRole = "A" | "B";

export const TOOL_CALL_PROBE_ENV = "HARNEXUS_PROBE_TOOL_CALL";
export const CALLER_THREAD_ENV = "HARNEXUS_PROBE_CALLER_THREAD";
export const TARGET_THREAD_ENV = "HARNEXUS_PROBE_TARGET_THREAD";

// Diagnostic only: the call is made while A has no running turn, the situation of a Claude thread.
export const createToolCallProbe = (
  env: NodeJS.ProcessEnv,
  log: (entry: LogEvent) => void,
  { quietMs = QUIET_MS } = {},
) => {
  const mode = env[TOOL_CALL_PROBE_ENV];
  if (mode !== "read" && mode !== "send") return null;
  const record = (
    step: ProbeStep,
    threadRole: ThreadRole | null,
    detail: string | null = null,
  ) => log({ event: "tool_call_probe", step, role: threadRole, detail });
  // Threads are never picked from what the app happens to open, since that once wrote to an unrelated thread of the user.
  const caller = env[CALLER_THREAD_ENV] ?? "";
  const target = mode === "send" ? (env[TARGET_THREAD_ENV] ?? "") : null;
  const refusal =
    caller === ""
      ? "caller_missing"
      : target === ""
        ? "target_missing"
        : target === caller
          ? "same_thread"
          : null;
  if (refusal !== null) {
    record("refused", null, refusal);
    return null;
  }
  const seen = new Set<string>();
  const active = new Set<string>();
  const approvals = new Map<string | number, ThreadRole | null>();
  let inject: ((line: string) => void) | null = null;
  let fired = false;
  let answered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ownResponse: Message | null = null;

  const role = (threadId: unknown): ThreadRole | null =>
    threadId === caller ? "A" : threadId === target ? "B" : null;

  // Both threads must have been loaded by the app before anything is sent.
  const schedule = () => {
    if (fired || inject === null) return;
    if (!seen.has(caller) || (target !== null && !seen.has(target))) return;
    clearTimeout(timer);
    if (active.has(caller)) return;
    timer = setTimeout(fire, quietMs);
  };

  const fire = () => {
    if (fired || inject === null || active.has(caller)) return;
    fired = true;
    const [tool, args] =
      target !== null
        ? [
            "send_message_to_thread",
            { threadId: target, prompt: replyPrompt(caller) },
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
    if (role(threadId) !== null && !seen.has(threadId as string)) {
      seen.add(threadId as string);
      record("thread_seen", role(threadId));
    }
    const subject = message.params?.threadId;
    if (message.method === "turn/started" && typeof subject === "string") {
      active.add(subject);
      if (role(subject)) record("turn_started", role(subject));
    }
    if (message.method === "turn/completed" && typeof subject === "string") {
      active.delete(subject);
      if (role(subject)) record("turn_completed", role(subject));
    }
    if (isApprovalRequest(message.method) && message.id !== undefined) {
      approvals.set(message.id, role(subject));
      record("approval_requested", role(subject), message.method ?? null);
    }
    schedule();
  };

  const onAppMessage = (message: Message) => {
    const subject = message.params?.threadId;
    if (message.method === "turn/start" && role(subject)) {
      record("turn_start_requested", role(subject));
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
    // The id is matched at the top level of a parsed response to the one request actually sent, so the same text nested in another message never matches.
    isOwnResponse: (line: Buffer) => {
      if (!fired || answered || !line.includes(CALL_ID_BYTES)) return false;
      const parsed = parseJson(line.toString());
      if (parsed.isErr()) return false;
      const message = parsed.value as Message;
      const own =
        typeof message === "object" &&
        message !== null &&
        !Array.isArray(message) &&
        message.id === CALL_ID &&
        !("method" in message) &&
        ("result" in message || "error" in message);
      ownResponse = own ? message : null;
      return own;
    },
    onOwnResponse: (_line: Buffer) => {
      const message = ownResponse ?? {};
      answered = true;
      ownResponse = null;
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
const CALL_ID_BYTES = Buffer.from(CALL_ID);
const DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const QUIET_MS = 15_000;
