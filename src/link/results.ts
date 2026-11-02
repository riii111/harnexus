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

export const failure = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export const withNote = (result: ToolResult, note: string): ToolResult => ({
  ...result,
  content: [...result.content, { type: "text", text: note }],
});
