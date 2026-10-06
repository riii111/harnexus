import { z } from "zod";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import { createSerialQueue } from "../../runtime/serial-queue.ts";
import {
  type DelegationWatch,
  FIRST_TURN_WAIT_MS,
  type FirstTurn,
  type TurnSettings,
} from "./delegations.ts";
import type { ServerRequest, ServerRequestError } from "./server-requests.ts";

// The answer names what is known about the call, so the caller can tell a call that never left from one whose effect is unknown and must not be repeated.
// A create_thread is answered once the new thread's first turn is seen, with its real id and the model and effort that turn asked for.
export type GatewayAnswer =
  | { outcome: "done" | "tool_error"; result: unknown }
  | ({ outcome: "done"; result: unknown; threadId: string } & TurnSettings)
  | {
      outcome: "model_mismatch";
      threadId: string;
      expected: TurnSettings;
      actual: TurnSettings;
    }
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

type ToolAnswer = { content: unknown; isError?: boolean | undefined };

type Link = {
  call: (name: string, args: unknown) => Promise<ToolAnswer>;
  createChecked: (args: unknown) => Promise<{
    result: ToolAnswer;
    firstTurn: FirstTurn | null;
    threadId: string | null;
    unknown: boolean;
  }>;
};

// A process outside the app sends one Codex app tool call per line on behalf of an existing thread; it sends exactly what it is given and keeps no state of its own.
// Claude threads go through their codex_link, so a reviewer they create is recorded and reachable from the Claude chat as if Claude had created it.
// A Codex thread's create_thread is not recorded anywhere; the watch only learns the new thread's id and checks its first turn.
export const createCallGateway = ({
  isClaudeThread,
  openLink,
  request,
  delegations,
  firstTurnWaitMs = FIRST_TURN_WAIT_MS,
}: {
  isClaudeThread: (threadId: string) => boolean;
  openLink: (threadId: string) => Link;
  request: ServerRequest;
  delegations: Pick<DelegationWatch, "expect" | "isWaiting">;
  firstTurnWaitMs?: number;
}) => {
  // One socket create at a time per caller, since a first turn is paired with the oldest waiting create of its caller.
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

  const handle = async (line: string): Promise<GatewayAnswer> => {
    const parsed = parseJson(line);
    const call = CALL.safeParse(parsed.isOk() ? parsed.value : undefined);
    if (!call.success) {
      return {
        outcome: "invalid",
        message: `expected {"threadId","tool","arguments"} with tool one of ${APP_TOOLS.join(", ")}`,
      };
    }
    const { threadId, tool, arguments: args } = call.data;
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

  // The in-chat create_thread of a Claude caller's own model is not serialized with these, so the two can still be paired crosswise.
  const createThread = async (
    threadId: string,
    args: Record<string, unknown>,
  ): Promise<GatewayAnswer> => {
    if (delegations.isWaiting(threadId)) {
      return {
        outcome: "not_sent",
        message:
          "an earlier create_thread of this thread is still unconfirmed, so another is not sent until its first turn is seen or its check expires",
      };
    }
    if (isClaudeThread(threadId)) {
      const created = await linkOf(threadId).createChecked(args);
      return createdAnswer(created);
    }
    // Registered before the call is sent, since the new thread's first turn can reach the bridge before the tool answer.
    const created = delegations.expect(threadId, {
      expected: {
        model: stringOrNull(args.model),
        effort: stringOrNull(args.thinking),
      },
      record: false,
    });
    const answered = await callApp(threadId, "create_thread", args);
    if (answered.isOk()) {
      const result = answered.value;
      const failed = isObject(result) && result.isError === true;
      // The app may answer with an error because the first turn was refused, so a turn already seen is still reported.
      const firstTurn = await created.wait(failed ? 0 : firstTurnWaitMs);
      if (failed) created.cancel();
      return createdAnswer({
        result,
        firstTurn,
        threadId: firstTurn?.threadId ?? null,
        unknown: firstTurn === null && !failed,
      });
    }
    // A thread already seen exists whatever became of the answer.
    const firstTurn = await created.wait(0);
    if (firstTurn !== null) {
      return createdAnswer({
        result: null,
        firstTurn,
        threadId: firstTurn.threadId,
        unknown: false,
      });
    }
    // A create_thread whose answer was lost may still have made the thread, so its check stays armed.
    if (answered.error._tag !== "ServerRequestUnanswered") created.cancel();
    return failedCall(answered.error);
  };

  const callApp = (
    threadId: string,
    tool: AppTool,
    args: Record<string, unknown>,
  ) =>
    request(
      "mcpServer/tool/call",
      { threadId, server: CODEX_APP_SERVER, tool, arguments: args },
      { timeoutMs: timeoutOf(tool, args) },
    );

  return {
    handle: async (line: string) => JSON.stringify(await handle(line)),
  };
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

// A thread known to exist is never answered as an error, since the caller would then create another.
const createdAnswer = ({
  result,
  firstTurn,
  threadId,
  unknown,
}: {
  result: unknown;
  firstTurn: FirstTurn | null;
  threadId: string | null;
  unknown: boolean;
}): GatewayAnswer => {
  if (firstTurn?.refused === true) {
    return {
      outcome: "model_mismatch",
      threadId: firstTurn.threadId,
      expected: firstTurn.expected,
      actual: firstTurn.actual,
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

const CALL = z.strictObject({
  threadId: z.string().min(1),
  tool: z.enum(APP_TOOLS),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const CODEX_APP_SERVER = "codex_app";
const CALL_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 120_000;
const MAX_WAIT_MS = 600_000;
const WAIT_MARGIN_MS = 30_000;
