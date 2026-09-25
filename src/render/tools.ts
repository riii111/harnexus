import type {
  CommandExecutionItem,
  FileChangeItem,
  FileUpdateChange,
  McpToolCallItem,
  ToolItem,
} from "./protocol.ts";

export type ToolUse = { name: string; input: unknown };

export type ToolResult = {
  content: unknown;
  isError: boolean;
  declined: boolean;
  // The tool's structured output from the SDK, whose shape depends on the tool.
  output: unknown;
  durationMs: number;
};

// Claude Code tools without an app counterpart fall back to a generic MCP-style item so their arguments and result stay visible.
export const startToolItem = (
  id: string,
  use: ToolUse,
  cwd: string,
): ToolItem => {
  const input = asRecord(use.input);
  if (use.name === "Bash" && typeof input.command === "string") {
    return startCommand(id, input.command, cwd);
  }
  if (
    use.name === "Edit" &&
    typeof input.file_path === "string" &&
    typeof input.old_string === "string" &&
    typeof input.new_string === "string"
  ) {
    return startFileChange(id, {
      path: input.file_path,
      kind: UPDATE,
      diff: replacementDiff(input.old_string, input.new_string),
    });
  }
  if (
    use.name === "Write" &&
    typeof input.file_path === "string" &&
    typeof input.content === "string"
  ) {
    return startFileChange(id, {
      path: input.file_path,
      kind: { type: "add" },
      diff: input.content,
    });
  }
  return startGeneric(id, use);
};

export const completeToolItem = (
  item: ToolItem,
  result: ToolResult,
): ToolItem => {
  switch (item.type) {
    case "commandExecution":
      return completeCommand(item, result);
    case "fileChange":
      return completeFileChange(item, result);
    case "mcpToolCall":
      return completeGeneric(item, result);
  }
};

// An MCP tool call has no declined status, so a refused one stays failed.
export const declineToolItem = (item: ToolItem): ToolItem | null =>
  item.type === "mcpToolCall" ? null : { ...item, status: "declined" };

// A tool left open when the turn ends never reports a result, so it is closed as failed rather than left running in the app.
export const abandonToolItem = (item: ToolItem): ToolItem =>
  item.type === "mcpToolCall"
    ? { ...item, status: "failed", error: { message: ABANDONED } }
    : { ...item, status: "failed" };

const startCommand = (
  id: string,
  command: string,
  cwd: string,
): CommandExecutionItem => ({
  type: "commandExecution",
  id,
  pluginId: null,
  scriptPath: null,
  command,
  cwd,
  processId: null,
  source: "agent",
  status: "inProgress",
  commandActions: [{ type: "unknown", command }],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
});

const startFileChange = (
  id: string,
  change: FileUpdateChange,
): FileChangeItem => ({
  type: "fileChange",
  id,
  changes: [change],
  status: "inProgress",
});

const startGeneric = (id: string, use: ToolUse): McpToolCallItem => {
  const mcp = MCP_TOOL_NAME.exec(use.name);
  return {
    type: "mcpToolCall",
    id,
    server: mcp?.[1] ?? CLAUDE_TOOL_SERVER,
    tool: mcp?.[2] ?? use.name,
    status: "inProgress",
    arguments: use.input,
    appContext: null,
    pluginId: null,
    readOnlyHint: null,
    result: null,
    error: null,
    durationMs: null,
  };
};

const completeCommand = (
  item: CommandExecutionItem,
  result: ToolResult,
): CommandExecutionItem => {
  if (result.declined) return { ...item, status: "declined" };
  const text = resultText(result.content);
  return {
    ...item,
    status: result.isError ? "failed" : "completed",
    aggregatedOutput: text,
    exitCode: result.isError ? exitCodeOf(text) : 0,
    durationMs: result.durationMs,
  };
};

const completeFileChange = (
  item: FileChangeItem,
  result: ToolResult,
): FileChangeItem => {
  if (result.declined) return { ...item, status: "declined" };
  if (result.isError) return { ...item, status: "failed" };
  const applied = appliedChange(result.output);
  return {
    ...item,
    changes: applied === null ? item.changes : [applied],
    status: "completed",
  };
};

const completeGeneric = (
  item: McpToolCallItem,
  result: ToolResult,
): McpToolCallItem => {
  if (result.declined || result.isError) {
    return {
      ...item,
      status: "failed",
      error: { message: resultText(result.content) },
      durationMs: result.durationMs,
    };
  }
  return {
    ...item,
    status: "completed",
    result: {
      content: resultContent(result.content),
      structuredContent: null,
      _meta: null,
    },
    durationMs: result.durationMs,
  };
};

// The Edit and Write outputs carry the applied hunks with line numbers, which the proposed input cannot provide.
const appliedChange = (output: unknown): FileUpdateChange | null => {
  const record = asRecord(output);
  if (typeof record.filePath !== "string") return null;
  if (record.type === "create" && typeof record.content === "string") {
    return {
      path: record.filePath,
      kind: { type: "add" },
      diff: record.content,
    };
  }
  if (!Array.isArray(record.structuredPatch)) return null;
  return {
    path: record.filePath,
    kind: UPDATE,
    diff: record.structuredPatch.map(formatHunk).join(""),
  };
};

const formatHunk = (hunk: unknown) => {
  const { oldStart, oldLines, newStart, newLines, lines } = asRecord(hunk);
  const body = Array.isArray(lines) ? lines.map((line) => `${line}\n`) : [];
  return `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n${body.join("")}`;
};

// The proposed edit has no line numbers, so the hunk starts at line 1 until the applied hunks replace it.
const replacementDiff = (oldText: string, newText: string) => {
  const removed = diffLines(oldText);
  const added = diffLines(newText);
  return [
    `@@ -1,${removed.length} +1,${added.length} @@\n`,
    ...removed.map((line) => `-${line}\n`),
    ...added.map((line) => `+${line}\n`),
  ].join("");
};

const diffLines = (text: string) =>
  text === "" ? [] : text.replace(/\n$/, "").split("\n");

// Claude Code reports a non-zero exit only in the result text.
const exitCodeOf = (text: string) => {
  const match = EXIT_CODE.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
};

const resultText = (content: unknown) =>
  resultContent(content)
    .map((block) => asRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");

const resultContent = (content: unknown): unknown[] => {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.map(toMcpContent) : [];
};

// Tool results use the Anthropic image block, while the app reads MCP content with the image data at the top level.
const toMcpContent = (block: unknown) => {
  const record = asRecord(block);
  if (record.type !== "image") return block;
  const source = asRecord(record.source);
  if (source.type === "base64") {
    return { type: "image", data: source.data, mimeType: source.media_type };
  }
  return {
    type: "text",
    text: `[image: ${String(source.url ?? source.type)}]`,
  };
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const UPDATE = { type: "update", move_path: null } as const;
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;
const EXIT_CODE = /^Exit code (\d+)/;
const CLAUDE_TOOL_SERVER = "claude";
const ABANDONED = "The turn ended before the tool finished.";
