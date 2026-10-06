import { z } from "zod";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import type { ServerRequest } from "./server-requests.ts";

// The answer names what is known about the call, so the caller can tell a call that never left from one whose effect is unknown and must not be repeated.
export type GatewayAnswer =
  | { outcome: "done" | "tool_error"; result: unknown }
  | {
      outcome: "not_sent" | "unknown" | "rejected" | "invalid";
      message: string;
    };

type ToolAnswer = { content: unknown; isError?: boolean | undefined };

type Link = { call: (name: string, args: unknown) => Promise<ToolAnswer> };

// A process outside the app sends one Codex app tool call per line on behalf of an existing thread; it sends exactly what it is given and keeps no state of its own.
// Claude threads go through their codex_link, so a reviewer they create is recorded and reachable from the Claude chat as if Claude had created it.
export const createCallGateway = ({
  isClaudeThread,
  openLink,
  request,
}: {
  isClaudeThread: (threadId: string) => boolean;
  openLink: (threadId: string) => Link;
  request: ServerRequest;
}) => {
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
    if (isClaudeThread(threadId)) {
      const result = await linkOf(threadId).call(tool, args);
      return {
        outcome: result.isError === true ? "tool_error" : "done",
        result,
      };
    }
    const answered = await request(
      "mcpServer/tool/call",
      { threadId, server: CODEX_APP_SERVER, tool, arguments: args },
      { timeoutMs: timeoutOf(tool, args) },
    );
    if (answered.isOk()) {
      const result = answered.value;
      return {
        outcome:
          isObject(result) && result.isError === true ? "tool_error" : "done",
        result,
      };
    }
    const error = answered.error;
    switch (error._tag) {
      case "ServerRequestNotSent":
        return { outcome: "not_sent", message: error.message };
      case "ServerRequestUnanswered":
        return { outcome: "unknown", message: error.message };
      case "ServerRequestRejected":
        return { outcome: "rejected", message: error.message };
    }
  };

  return {
    handle: async (line: string) => JSON.stringify(await handle(line)),
  };
};

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
