import type {
  SDKAssistantMessage,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { UserInput } from "../../infra/codex/protocol/messages.ts";
import { isObject } from "../../lib/object.ts";
import { RECOVERY_CONTEXT } from "../turn/recovery.view.ts";

export const opensTurn = (prompt: Prompt) =>
  !INTERRUPTED.test(prompt.text) && !LOCAL_COMMAND.test(prompt.text);

export type Prompt = {
  text: string;
  images: UserInput[];
  recovering?: boolean;
};

export const inputOf = (prompt: Prompt): UserInput[] => [
  // An image sent alone has no text to show beside it.
  ...(prompt.text === "" && prompt.images.length > 0
    ? []
    : [{ type: "text", text: prompt.text, text_elements: [] }]),
  ...prompt.images,
];

// The prompt a user record holds, or null for one carrying tool results, which continues the turn.
export const promptOf = (body: unknown): Prompt | null => {
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
  const typed: unknown = content.find(
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

export const isAssistantBody = (
  body: unknown,
): body is SDKAssistantMessage["message"] =>
  // The SDK types a record's message as unknown, so only a message with the fields the renderer reads is replayed.
  isObject(body) && typeof body.id === "string" && Array.isArray(body.content);

export const assistantOf = (
  message: SessionMessage,
  body: SDKAssistantMessage["message"],
): SDKAssistantMessage => ({
  type: "assistant",
  message: body,
  parent_tool_use_id: null,
  uuid: message.uuid as SDKAssistantMessage["uuid"],
  session_id: message.session_id,
});

export const toolResultsOf = (
  message: SessionMessage,
  body: unknown,
): SDKUserMessage => ({
  type: "user",
  // A user record without a prompt carries tool results.
  message: body as SDKUserMessage["message"],
  parent_tool_use_id: null,
  session_id: message.session_id,
});

export const isMetaMessage = (message: SessionMessage) =>
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

// Claude Code writes these as user messages when a turn is stopped.
export const INTERRUPTED = /^\[Request interrupted by user/;

// A slash command such as /compact is recorded as its command, caveat and output rather than as a prompt Claude answered.
const LOCAL_COMMAND =
  /^<(command-name|local-command-stdout|local-command-caveat)>/;
