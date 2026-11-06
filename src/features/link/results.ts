// Only types come from the SDK, so the SDK itself is loaded only when a Claude session starts.
import type {
  SdkMcpToolDefinition,
  tool,
} from "@anthropic-ai/claude-agent-sdk";

export type ToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

// The definition the SDK's tool() builds, written out here.
export const defineTool: typeof tool = (
  name,
  description,
  inputSchema,
  handler,
  extras,
) => ({
  name,
  description,
  inputSchema,
  handler,
  ...(extras?.annotations !== undefined && { annotations: extras.annotations }),
});

// What a failed call tells a caller of the call socket, which reads it instead of the text written for Claude.
export type FailureKind = "not_sent" | "rejected" | "unknown" | "invalid";

// Kept beside the result rather than in it, so what Claude reads does not change.
const failureKinds = new WeakMap<object, FailureKind>();

export const failure = (
  text: string,
  kind: FailureKind = "rejected",
): ToolResult => {
  const result: ToolResult = {
    content: [{ type: "text", text }],
    isError: true,
  };
  failureKinds.set(result, kind);
  return result;
};

// A failure the app itself answered carries no kind, and is a refusal of a call that reached it.
export const failureKindOf = (result: object): FailureKind =>
  failureKinds.get(result) ?? "rejected";

export const withNote = (result: ToolResult, note: string): ToolResult => ({
  ...result,
  content: [...result.content, { type: "text", text: note }],
});
