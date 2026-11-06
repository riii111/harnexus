import { z } from "zod";

import type {
  ServerRequest,
  ServerRequestError,
} from "../../infra/codex/server-requests.ts";
import { parseJson } from "../../lib/json.boundary.ts";
import { isObject } from "../../lib/object.ts";
import { createSerialQueue } from "../../lib/serial-queue.ts";
import { createCloudOpen, type StartCloud } from "./cloud-open.ts";
import {
  type CreateOutcome,
  concludeCreate,
  type DelegationWatch,
  FIRST_TURN_WAIT_MS,
  firstTurnRefusal,
  type TurnSettings,
} from "./delegations.ts";
import { failureKindOf } from "./results.ts";

// The answer names what is known about the call, so the caller can tell a call that never left from one whose effect is unknown and must not be repeated.
type GatewayAnswer =
  | { outcome: "done" | "tool_error"; result: unknown }
  | ({ outcome: "done"; result: unknown; threadId: string } & TurnSettings)
  | {
      outcome: "model_mismatch";
      threadId: string;
      expected: TurnSettings;
      actual: TurnSettings;
    }
  | { outcome: "first_turn_refused"; threadId: string; reason: string }
  | {
      outcome: "unknown";
      message: string;
      result?: unknown;
      threadId?: string;
    }
  | {
      outcome: "not_sent" | "rejected" | "invalid";
      message: string;
    };

// Shared with every caller of the socket, so none can miss or misspell an outcome.
export type CallOutcome = GatewayAnswer["outcome"];

type ToolAnswer = { content: unknown; isError?: boolean | undefined };

type Link = {
  call: (name: string, args: unknown) => Promise<ToolAnswer>;
  createChecked: (args: unknown) => Promise<CreateOutcome & { busy: boolean }>;
  exclusive: <T>(
    label: string,
    run: () => Promise<T>,
    isUnknown: (value: T) => boolean,
  ) => Promise<{ ran: T } | { refused: ToolAnswer }>;
};

// Serves the call socket's thread tools to harnexus-task, sending a Claude thread's calls through its codex_link.
export const createCallGateway = ({
  isClaudeThread,
  openLink,
  request,
  delegations,
  cloudOwner = () => undefined,
  startCloud,
  firstTurnWaitMs = FIRST_TURN_WAIT_MS,
}: {
  isClaudeThread: (threadId: string) => boolean;
  // The chat a Cloud session is linked to, however it was linked.
  cloudOwner?: (cloudSessionId: string) => string | undefined;
  openLink: (threadId: string) => Link;
  request: ServerRequest;
  delegations: Pick<DelegationWatch, "expect">;
  // Starts a Cloud session for cloud_open; without it cloud_open only opens chats for sessions already started.
  startCloud?: StartCloud;
  firstTurnWaitMs?: number;
}) => {
  // Queued rather than refused, so a script's creates in a row each go out once the previous one is confirmed.
  const creates = createSerialQueue();
  // Kept per thread, so an unknown write stops later writes from the same thread.
  const links = new Map<string, Link>();

  const linkOf = (threadId: string) => {
    const known = links.get(threadId);
    if (known !== undefined) return known;
    const opened = openLink(threadId);
    links.set(threadId, opened);
    return opened;
  };

  // A request that names a version is answered by that version; one without is the first protocol, answered as before.
  const handle = async (line: string): Promise<object> => {
    const parsed = parseJson(line);
    const value = parsed.isOk() ? parsed.value : undefined;
    if (isObject(value) && Object.hasOwn(value, "version"))
      return handleV1(value);
    const call = CALL.safeParse(value);
    if (!call.success) {
      return {
        outcome: "invalid",
        message: `expected {"threadId","tool","arguments"} with tool one of ${TOOLS.join(", ")}`,
      };
    }

    const { threadId, tool, arguments: args } = call.data;
    return run(threadId, tool, args);
  };

  const handleV1 = async (value: Record<string, unknown>): Promise<object> => {
    if (value.version !== PROTOCOL_VERSION)
      return {
        outcome: "invalid",
        message: `protocol version ${JSON.stringify(value.version)} is not supported`,
        versions: [PROTOCOL_VERSION],
      };
    if (QUERY_V1.safeParse(value).success)
      return {
        version: PROTOCOL_VERSION,
        outcome: "done",
        operations: TOOLS_V1,
      };
    const call = CALL_V1.safeParse(value);
    if (!call.success)
      return {
        version: PROTOCOL_VERSION,
        outcome: "invalid",
        message: `expected {"version":1,"query":"capabilities"} or {"version":1,"threadId","tool","arguments"} with tool one of ${TOOLS_V1.join(", ")}`,
      };
    const { threadId, tool, arguments: args } = call.data;
    const answer =
      tool === "cloud_open"
        ? await openCloud(threadId, args)
        : await run(threadId, tool, args);
    return { version: PROTOCOL_VERSION, ...structured(answer) };
  };

  const run = async (
    threadId: string,
    tool: Tool,
    args: Record<string, unknown>,
  ): Promise<GatewayAnswer> => {
    if (tool === "name_thread") return nameThread(threadId, args);
    if (tool === "cloud_chat") {
      const sessionId = args.sessionId;
      return typeof sessionId === "string"
        ? {
            outcome: "done",
            result: { threadId: cloudOwner(sessionId) ?? null },
          }
        : { outcome: "invalid", message: "cloud_chat expects a sessionId" };
    }

    if (tool === "create_thread") {
      return creates.run(threadId, () => createThread(threadId, args));
    }

    if (isClaudeThread(threadId)) {
      const result = await linkOf(threadId).call(tool, args);
      return {
        outcome: result.isError === true ? "tool_error" : "done",
        result,
      };
    }

    const answered = await callApp(threadId, tool, args);
    if (answered.isOk()) {
      const result = answered.value;
      return {
        outcome:
          isObject(result) && result.isError === true ? "tool_error" : "done",
        result,
      };
    }

    return failedCall(answered.error);
  };

  // Names the thread the call came from; harnexus-task sends only the worker's own thread.
  const nameThread = async (
    threadId: string,
    args: Record<string, unknown>,
  ): Promise<GatewayAnswer> => {
    const name = args.name;
    if (typeof name !== "string" || name.trim() === "" || /[\r\n]/.test(name))
      return {
        outcome: "invalid",
        message: "name_thread expects a nonempty single-line name",
      };
    const named = await request(
      "thread/name/set",
      { threadId, name },
      { timeoutMs: CALL_TIMEOUT_MS },
    );
    return named.isOk()
      ? { outcome: "done", result: named.value }
      : failedCall(named.error);
  };

  const createThread = async (
    threadId: string,
    args: Record<string, unknown>,
  ): Promise<GatewayAnswer> => {
    if (isClaudeThread(threadId)) {
      const created = await linkOf(threadId).createChecked(args);
      return created.busy ? BUSY : createdAnswer(created);
    }

    // Registered before the call is sent, since the new thread's first turn can reach the bridge before the tool answer.
    const created = delegations.expect(threadId, {
      expected: {
        model: stringOrNull(args.model),
        effort: stringOrNull(args.thinking),
      },
    });
    if (created === null) return BUSY;
    const answered = await callApp(threadId, "create_thread", args);
    if (answered.isOk()) {
      return createdAnswer(
        await concludeCreate(created, {
          answer: { result: answered.value },
          waitMs: firstTurnWaitMs,
        }),
      );
    }

    const lost = await concludeCreate(created, {
      answer: null,
      waitMs: 0,
      // A lost answer may still have made the thread.
      mayExist: answered.error._tag === "ServerRequestUnanswered",
    });
    return lost.firstTurn === null
      ? failedCall(answered.error)
      : createdAnswer(lost);
  };

  const callApp = async (
    threadId: string,
    tool: AppTool,
    args: Record<string, unknown>,
  ) => {
    const called = await callTool(threadId, tool, args);
    // A rejected call never ran, so it can be sent again once the caller is loaded.
    if (called.isOk() || !isUnloaded(called.error, threadId)) return called;

    // The app server forgets an idle Codex thread and then rejects it as a caller; loading it again starts no turn.
    const loaded = await request(
      "thread/resume",
      { threadId, excludeTurns: true },
      { timeoutMs: CALL_TIMEOUT_MS },
    );
    return loaded.isOk() ? callTool(threadId, tool, args) : called;
  };

  const callTool = (
    threadId: string,
    tool: AppTool,
    args: Record<string, unknown>,
  ) =>
    request(
      "mcpServer/tool/call",
      { threadId, server: CODEX_APP_SERVER, tool, arguments: args },
      { timeoutMs: timeoutOf(tool, args) },
    );

  // A Codex caller has no turn to stop, so its starts are only kept in order.
  const codexStarts = createSerialQueue();

  const openCloud = createCloudOpen({
    call: async (caller, tool, args) =>
      structured(await run(caller, tool, args)),
    cloudOwner,
    ...(startCloud !== undefined && { startCloud }),
    guardStart: async (caller, start) => {
      if (!isClaudeThread(caller))
        return { ran: await codexStarts.run(caller, start) };
      const guarded = await linkOf(caller).exclusive(
        "cloud_open",
        start,
        (started) => (started.isErr() ? started.error.mayHaveStarted : false),
      );
      return "ran" in guarded
        ? guarded
        : {
            refused: structured({
              outcome: "tool_error",
              result: guarded.refused,
            }),
          };
    },
  });

  return {
    handle: async (line: string) => JSON.stringify(await handle(line)),
  };
};

// The first protocol answers a failed tool as tool_error with text written for Claude; later ones name what is known of the call instead.
const structured = (answer: { outcome: string; [key: string]: unknown }) => {
  if (answer.outcome !== "tool_error") return answer;
  const { result } = answer;
  return {
    ...answer,
    outcome: isObject(result) ? failureKindOf(result) : "rejected",
    message: textOf(result),
  };
};

const textOf = (result: unknown) => {
  const content = isObject(result) ? result.content : undefined;
  const texts = Array.isArray(content)
    ? content.flatMap((item) =>
        isObject(item) && item.type === "text" && typeof item.text === "string"
          ? [item.text]
          : [],
      )
    : [];
  return texts.length > 0 ? texts.join("\n") : "the call failed";
};

const BUSY: GatewayAnswer = {
  outcome: "not_sent",
  message:
    "an earlier create_thread of this thread is still unconfirmed, so another is not sent until its first turn is seen or its check expires",
};

const failedCall = (error: ServerRequestError): GatewayAnswer => {
  switch (error._tag) {
    case "ServerRequestNotSent":
      return { outcome: "not_sent", message: error.message };
    case "ServerRequestUnanswered":
      return { outcome: "unknown", message: error.message };
    case "ServerRequestRejected":
      return { outcome: "rejected", message: error.message };
  }
};

const isUnloaded = (error: ServerRequestError, threadId: string) =>
  error._tag === "ServerRequestRejected" &&
  error.message.includes(`thread not found: ${threadId}`);

const createdAnswer = ({
  result,
  firstTurn,
  threadId,
  unknown,
}: CreateOutcome): GatewayAnswer => {
  const refusal = firstTurnRefusal(firstTurn);
  // A thread known to exist is never answered as an error, since the caller would then create another.
  if (refusal?.kind === "settings") {
    return {
      outcome: "model_mismatch",
      threadId: refusal.threadId,
      expected: refusal.expected,
      actual: refusal.actual,
    };
  }

  if (refusal?.kind === "bridge") {
    return {
      outcome: "first_turn_refused",
      threadId: refusal.threadId,
      reason: refusal.reason,
    };
  }

  if (unknown) {
    return {
      outcome: "unknown",
      message:
        "the new thread may exist but its first turn was not seen in time or it could not be recorded; do not create it again, and a later first turn on another model is still refused",
      result,
      ...(threadId !== null && { threadId }),
    };
  }

  if (firstTurn === null) return { outcome: "tool_error", result };
  return {
    outcome: "done",
    result,
    threadId: firstTurn.threadId,
    ...firstTurn.actual,
  };
};

const stringOrNull = (value: unknown) =>
  typeof value === "string" ? value : null;

const timeoutOf = (tool: AppTool, args: Record<string, unknown>) => {
  if (tool === "wait_threads") {
    const asked = args.timeoutMs;
    return (typeof asked === "number" ? asked : MAX_WAIT_MS) + WAIT_MARGIN_MS;
  }

  return tool === "create_thread" || tool === "send_message_to_thread"
    ? WRITE_TIMEOUT_MS
    : CALL_TIMEOUT_MS;
};

const APP_TOOLS = [
  "list_projects",
  "create_thread",
  "send_message_to_thread",
  "read_thread",
  "wait_threads",
] as const;

type AppTool = (typeof APP_TOOLS)[number];

// name_thread and cloud_chat are answered by the gateway itself: the app offers no tool that renames a thread, and only the bridge knows which chat shows a Cloud session.
const TOOLS = [...APP_TOOLS, "name_thread", "cloud_chat"] as const;

type Tool = (typeof TOOLS)[number];

const CALL = z.strictObject({
  threadId: z.string().min(1),
  tool: z.enum(TOOLS),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export const PROTOCOL_VERSION = 1;

// cloud_open is offered only to callers that asked for the version first, so an older bridge refuses it before anything is sent.
export const TOOLS_V1 = [...TOOLS, "cloud_open"] as const;

const QUERY_V1 = z.strictObject({
  version: z.literal(PROTOCOL_VERSION),
  query: z.literal("capabilities"),
});

const CALL_V1 = z.strictObject({
  version: z.literal(PROTOCOL_VERSION),
  threadId: z.string().min(1),
  tool: z.enum(TOOLS_V1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const CODEX_APP_SERVER = "codex_app";
const CALL_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 120_000;
const MAX_WAIT_MS = 600_000;
const WAIT_MARGIN_MS = 30_000;
