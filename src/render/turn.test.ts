import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AppNotification, ThreadItem } from "./protocol.ts";
import {
  finishTurn,
  type Rendered,
  renderSdkMessage,
  renderUserInput,
  startTurn,
} from "./turn.ts";

describe("text series", () => {
  test("streams text as agent message deltas and completes it as the final answer", () => {
    const out = run([
      ...streamedText("msg-1", ["Hel", "lo"], "end_turn"),
      success(),
    ]);

    expect(methods(out)).toEqual([
      "thread/status/changed",
      "turn/started",
      "item/started",
      "item/completed",
      "item/started",
      "item/agentMessage/delta",
      "item/agentMessage/delta",
      "item/completed",
      "thread/status/changed",
      "turn/completed",
    ]);
    expect(deltas(out)).toEqual(["Hel", "lo"]);
    const answer = completedItems(out).find(
      (item) => item.type === "agentMessage",
    );
    expect(answer).toMatchObject({
      id: "tu-1-item-2",
      text: "Hello",
      phase: "final_answer",
    });
    expect(turnCompleted(out)).toMatchObject({
      status: "completed",
      items: [answer],
      itemsView: "summary",
      error: null,
      startedAt: 1700000000,
      durationMs: 7,
    });
  });

  test("streams thinking as a reasoning item", () => {
    const out = run([
      streamEvent({ type: "message_start", message: { id: "msg-1" } }),
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "ponder" },
      }),
      streamEvent({ type: "content_block_stop", index: 0 }),
      success(),
    ]);

    expect(
      notificationsOf(out, "item/reasoning/textDelta")[0]?.params,
    ).toMatchObject({
      itemId: "tu-1-item-2",
      delta: "ponder",
      contentIndex: 0,
    });
    expect(completedItems(out)).toContainEqual({
      type: "reasoning",
      id: "tu-1-item-2",
      summary: [],
      content: ["ponder"],
    });
  });

  test("renders a whole assistant message when the stream did not carry it", () => {
    const out = run([
      assistant("msg-1", [{ type: "text", text: "whole" }], "end_turn"),
      success(),
    ]);

    const started = notificationsOf(out, "item/started").map(
      (n) => n.params.item,
    );
    expect(started).toContainEqual(
      expect.objectContaining({ type: "agentMessage", text: "" }),
    );
    expect(completedItems(out)).toContainEqual(
      expect.objectContaining({
        type: "agentMessage",
        text: "whole",
        phase: "final_answer",
      }),
    );
  });

  test("does not render a streamed block twice when its assistant message follows", () => {
    const out = run([
      ...streamedText("msg-1", ["once"], null),
      assistant("msg-1", [{ type: "text", text: "once" }], null),
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      }),
      success(),
    ]);

    expect(
      completedItems(out).filter((item) => item.type === "agentMessage"),
    ).toHaveLength(1);
  });

  test("ignores subagent messages", () => {
    const out = run([
      {
        ...assistant("msg-sub", [{ type: "text", text: "inner" }], "end_turn"),
        parent_tool_use_id: "tool-1",
      },
      success(),
    ]);

    expect(methods(out)).not.toContain("item/agentMessage/delta");
    expect(completedItems(out).map((item) => item.type)).toEqual([
      "userMessage",
    ]);
  });
});

describe("tool series", () => {
  test("closes preceding text as commentary before the tool item starts", () => {
    const out = run([
      ...streamedText("msg-1", ["let me look"], null),
      assistant("msg-1", [toolUse("tool-1", "Bash", { command: "ls" })], null),
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      }),
      toolResult("tool-1", "a.txt", false),
      success(),
    ]);

    const sequence = out.notifications
      .filter(
        (n) => n.method === "item/started" || n.method === "item/completed",
      )
      .map((n) => `${n.method} ${itemOf(n).type}`);
    expect(sequence).toEqual([
      "item/started userMessage",
      "item/completed userMessage",
      "item/started agentMessage",
      "item/completed agentMessage",
      "item/started commandExecution",
      "item/completed commandExecution",
    ]);
    expect(completedItems(out)[1]).toMatchObject({
      phase: "commentary",
      text: "let me look",
    });
  });

  test("maps Bash to a command execution with its output", () => {
    const out = run([
      assistant(
        "msg-1",
        [toolUse("tool-1", "Bash", { command: "ls" })],
        "tool_use",
      ),
      toolResult("tool-1", "a.txt", false),
      success(),
    ]);

    expect(completedTool(out)).toEqual({
      type: "commandExecution",
      id: "tu-1-item-2",
      pluginId: null,
      scriptPath: null,
      command: "ls",
      cwd: "/fixture/work",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [{ type: "unknown", command: "ls" }],
      aggregatedOutput: "a.txt",
      exitCode: 0,
      durationMs: 1,
    });
  });

  test("reads the exit code of a failed command from its result", () => {
    const out = run([
      assistant(
        "msg-1",
        [toolUse("tool-1", "Bash", { command: "false" })],
        "tool_use",
      ),
      toolResult("tool-1", "Exit code 2\nboom", true),
      success(),
    ]);

    expect(completedTool(out)).toMatchObject({ status: "failed", exitCode: 2 });
  });

  test("maps Edit to a file change and replaces the diff with the applied hunks", () => {
    const out = run([
      assistant(
        "msg-1",
        [
          toolUse("tool-1", "Edit", {
            file_path: "/fixture/work/a.txt",
            old_string: "old",
            new_string: "new",
          }),
        ],
        "tool_use",
      ),
      toolResult("tool-1", "updated", false, {
        filePath: "/fixture/work/a.txt",
        structuredPatch: [
          {
            oldStart: 3,
            oldLines: 1,
            newStart: 3,
            newLines: 1,
            lines: ["-old", "+new"],
          },
        ],
      }),
      success(),
    ]);

    expect(startedTool(out)).toMatchObject({
      type: "fileChange",
      changes: [
        {
          path: "/fixture/work/a.txt",
          kind: { type: "update", move_path: null },
          diff: "-old\n+new\n",
        },
      ],
      status: "inProgress",
    });
    expect(completedTool(out)).toMatchObject({
      changes: [{ diff: "@@ -3,1 +3,1 @@\n-old\n+new\n" }],
      status: "completed",
    });
  });

  test("maps Write of a new file to an added file", () => {
    const out = run([
      assistant(
        "msg-1",
        [
          toolUse("tool-1", "Write", {
            file_path: "/fixture/work/b.txt",
            content: "hi\n",
          }),
        ],
        "tool_use",
      ),
      toolResult("tool-1", "created", false, {
        type: "create",
        filePath: "/fixture/work/b.txt",
        content: "hi\n",
      }),
      success(),
    ]);

    expect(completedTool(out)).toMatchObject({
      type: "fileChange",
      changes: [
        { path: "/fixture/work/b.txt", kind: { type: "add" }, diff: "hi\n" },
      ],
      status: "completed",
    });
  });

  test("maps an MCP tool to its server and tool name", () => {
    const out = run([
      assistant(
        "msg-1",
        [
          toolUse("tool-1", "mcp__codex_link__read_thread", {
            threadId: "th-2",
          }),
        ],
        "tool_use",
      ),
      toolResult("tool-1", [{ type: "text", text: "thread body" }], false),
      success(),
    ]);

    expect(completedTool(out)).toMatchObject({
      type: "mcpToolCall",
      server: "codex_link",
      tool: "read_thread",
      arguments: { threadId: "th-2" },
      status: "completed",
      result: {
        content: [{ type: "text", text: "thread body" }],
        structuredContent: null,
        _meta: null,
      },
      error: null,
    });
  });

  test("shows other Claude tools as a generic item rather than command output", () => {
    const out = run([
      assistant(
        "msg-1",
        [toolUse("tool-1", "Read", { file_path: "/fixture/work/a.txt" })],
        "tool_use",
      ),
      toolResult("tool-1", "no such file", true),
      success(),
    ]);

    expect(completedTool(out)).toMatchObject({
      type: "mcpToolCall",
      server: "claude",
      tool: "Read",
      status: "failed",
      result: null,
      error: { message: "no such file" },
    });
  });

  test("marks a tool the permission check denied as declined", () => {
    const out = run([
      assistant(
        "msg-1",
        [toolUse("tool-1", "Bash", { command: "rm -rf x" })],
        "tool_use",
      ),
      {
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "tool-1",
      },
      toolResult("tool-1", "denied", true),
      success(),
    ]);

    expect(completedTool(out)).toMatchObject({
      status: "declined",
      aggregatedOutput: null,
    });
  });
});

describe("error series", () => {
  test("fails the turn with the result errors", () => {
    const out = run([
      ...streamedText("msg-1", ["partial"], null),
      result({
        subtype: "error_during_execution",
        is_error: true,
        errors: ["api down"],
      }),
    ]);

    const error = notificationsOf(out, "error")[0]?.params;
    expect(error).toEqual({
      error: {
        message: "api down",
        codexErrorInfo: null,
        additionalDetails: null,
      },
      willRetry: false,
      threadId: "th-1",
      turnId: "tu-1",
    });
    expect(turnCompleted(out)).toMatchObject({
      status: "failed",
      error: error?.error,
      items: [],
    });
    expect(completedItems(out)).toContainEqual(
      expect.objectContaining({ text: "partial", phase: null }),
    );
  });

  test("fails the turn when a successful result carries an API error", () => {
    const out = run([
      result({ subtype: "success", is_error: true, result: "rate limited" }),
    ]);

    expect(turnCompleted(out)).toMatchObject({
      status: "failed",
      error: { message: "rate limited" },
    });
  });
});

describe("interrupt series", () => {
  test("follows the recorded interrupt and closes the items left open", () => {
    let rendered = begin();
    const all = [...rendered.notifications];
    for (const message of [
      streamEvent({ type: "message_start", message: { id: "msg-1" } }),
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "1" },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "2" },
      }),
    ]) {
      rendered = renderSdkMessage(rendered.state, sdk(message), NOW);
      all.push(...rendered.notifications);
    }
    rendered = finishTurn(rendered.state, { status: "interrupted" }, NOW + 5);
    all.push(...rendered.notifications);
    const late = renderSdkMessage(rendered.state, sdk(success()), NOW + 6);

    // The recorded session has no user message item, and Codex leaves the interrupted message open where the bridge closes it.
    const recorded = fixtureNotifications("steer-and-interrupt.jsonl").map(
      shapeKey,
    );
    expect(
      all.map(shapeKey).filter((key) => !key.endsWith("userMessage")),
    ).toEqual([
      ...recorded.slice(0, 5),
      "item/completed agentMessage",
      ...recorded.slice(5),
    ]);
    expect(turnCompleted({ notifications: all })).toMatchObject({
      status: "interrupted",
      items: [],
    });
    expect(late.notifications).toEqual([]);
  });

  test("closes a running tool as failed", () => {
    let rendered = begin();
    rendered = renderSdkMessage(
      rendered.state,
      sdk(
        assistant(
          "msg-1",
          [toolUse("tool-1", "Bash", { command: "sleep 9" })],
          "tool_use",
        ),
      ),
      NOW,
    );
    rendered = finishTurn(rendered.state, { status: "interrupted" }, NOW + 1);

    expect(completedItems(rendered)).toContainEqual(
      expect.objectContaining({ type: "commandExecution", status: "failed" }),
    );
  });
});

describe("item ids", () => {
  test("pairs every started item with exactly one completion", () => {
    const out = run([
      ...streamedText("msg-1", ["a"], null),
      assistant(
        "msg-1",
        [
          toolUse("tool-1", "Bash", { command: "ls" }),
          toolUse("tool-2", "Read", {}),
        ],
        "tool_use",
      ),
      toolResult("tool-1", "x", false),
      toolResult("tool-2", "y", false),
      ...streamedText("msg-2", ["b"], "end_turn"),
      success(),
    ]);

    const started = notificationsOf(out, "item/started").map(
      (n) => n.params.item.id,
    );
    const completed = notificationsOf(out, "item/completed").map(
      (n) => n.params.item.id,
    );
    expect(new Set(started).size).toBe(started.length);
    expect([...completed].sort()).toEqual([...started].sort());
  });

  test("leaves the given state unchanged", () => {
    const { state } = begin();
    const before = structuredClone(state);

    renderSdkMessage(
      state,
      sdk(
        streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        }),
      ),
      NOW,
    );

    expect(state).toEqual(before);
  });
});

describe("fixture shapes", () => {
  test("every notification has the fields the app-server fixtures carry", () => {
    const samples = new Map<string, unknown>();
    for (const name of readdirSync(FIXTURE_DIR).filter((file) =>
      file.endsWith(".jsonl"),
    )) {
      for (const notification of fixtureNotifications(name)) {
        samples.set(shapeKey(notification), notification);
      }
    }
    const outputs = [
      run([...streamedText("msg-1", ["a"], "end_turn"), success()]),
      run([
        streamEvent({ type: "message_start", message: { id: "msg-1" } }),
        streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking" },
        }),
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "t" },
        }),
        streamEvent({ type: "content_block_stop", index: 0 }),
        assistant(
          "msg-1",
          [
            toolUse("tool-1", "Bash", { command: "ls" }),
            toolUse("tool-2", "Edit", {
              file_path: "/a",
              old_string: "o",
              new_string: "n",
            }),
            toolUse("tool-3", "mcp__s__t", {}),
          ],
          "tool_use",
        ),
        toolResult("tool-1", "x", false),
        toolResult("tool-2", "ok", false),
        toolResult("tool-3", "bad", true),
        result({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["e"],
        }),
      ]),
      finishTurn(begin().state, { status: "interrupted" }, NOW),
    ];

    const checked = new Set<string>();
    for (const notification of outputs.flatMap((out) => out.notifications)) {
      const key = shapeKey(notification);
      const sample = samples.get(key);
      expect(sample === undefined ? `no fixture for ${key}` : null).toBeNull();
      expect(shapeMismatches(notification, sample)).toEqual([]);
      checked.add(key);
    }
    expect(checked.size).toBeGreaterThanOrEqual(18);
  });
});

const NOW = 1700000000500;
// Tool arguments are whatever the model passed, so they have no fixed shape.
const FREE_FORM_KEYS = new Set(["arguments"]);
const FIXTURE_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "test",
  "fixtures",
  "app-server",
);

const begin = (): Rendered => {
  const started = startTurn({
    threadId: "th-1",
    turnId: "tu-1",
    cwd: "/fixture/work",
    now: NOW,
  });
  const input = renderUserInput(
    started.state,
    [{ type: "text", text: "hi", text_elements: [] }],
    null,
    NOW,
  );
  return {
    state: input.state,
    notifications: [...started.notifications, ...input.notifications],
  };
};

// Each message advances the clock by one millisecond so durations are predictable.
const run = (messages: object[]) => {
  let { state, notifications } = begin();
  const all = [...notifications];
  messages.forEach((message, index) => {
    ({ state, notifications } = renderSdkMessage(
      state,
      sdk(message),
      NOW + index + 1,
    ));
    all.push(...notifications);
  });
  return { state, notifications: all };
};

const sdk = (message: object) => message as SDKMessage;

const streamedText = (
  id: string,
  chunks: string[],
  stopReason: string | null,
): object[] => [
  streamEvent({ type: "message_start", message: { id } }),
  streamEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text" },
  }),
  ...chunks.map((text) =>
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
  ),
  streamEvent({ type: "content_block_stop", index: 0 }),
  ...(stopReason === null
    ? []
    : [
        streamEvent({
          type: "message_delta",
          delta: { stop_reason: stopReason },
        }),
      ]),
];

const streamEvent = (event: object) => ({
  type: "stream_event",
  event,
  parent_tool_use_id: null,
});

const assistant = (
  id: string,
  content: object[],
  stopReason: string | null,
) => ({
  type: "assistant",
  message: { id, content, stop_reason: stopReason },
  parent_tool_use_id: null,
});

const toolUse = (id: string, name: string, input: object) => ({
  type: "tool_use",
  id,
  name,
  input,
});

const toolResult = (
  toolUseId: string,
  content: unknown,
  isError: boolean,
  output?: object,
) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
        is_error: isError,
      },
    ],
  },
  parent_tool_use_id: null,
  tool_use_result: output,
});

const success = () =>
  result({ subtype: "success", is_error: false, result: "done" });

const result = (fields: object) => ({ type: "result", errors: [], ...fields });

const methods = (out: { notifications: AppNotification[] }) =>
  out.notifications.map((n) => n.method);

const notificationsOf = <M extends AppNotification["method"]>(
  out: { notifications: AppNotification[] },
  method: M,
) =>
  out.notifications.filter(
    (n): n is Extract<AppNotification, { method: M }> => n.method === method,
  );

const deltas = (out: { notifications: AppNotification[] }) =>
  notificationsOf(out, "item/agentMessage/delta").map((n) => n.params.delta);

const completedItems = (out: { notifications: AppNotification[] }) =>
  notificationsOf(out, "item/completed").map((n) => n.params.item);

const startedTool = (out: { notifications: AppNotification[] }) =>
  notificationsOf(out, "item/started")
    .map((n) => n.params.item)
    .find(isTool);

const completedTool = (out: { notifications: AppNotification[] }) =>
  completedItems(out).find(isTool);

const isTool = (item: ThreadItem) =>
  item.type === "commandExecution" ||
  item.type === "fileChange" ||
  item.type === "mcpToolCall";

const turnCompleted = (out: { notifications: AppNotification[] }) =>
  notificationsOf(out, "turn/completed")[0]?.params.turn;

const itemOf = (notification: AppNotification) =>
  (notification.params as { item: ThreadItem }).item;

const fixtureNotifications = (name: string): Record<string, unknown>[] =>
  readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter(
      (record) =>
        record.direction === "server_to_app" &&
        record.message.method !== undefined,
    )
    .filter((record) => record.message.id === undefined)
    .map((record) => record.message);

// Notifications are grouped by method and the variant they carry, since each variant has its own fields.
const shapeKey = (notification: object) => {
  const { method, params } = notification as {
    method: string;
    params: Record<string, never>;
  };
  const item = params.item as { type?: string } | undefined;
  const status = params.status as { type?: string } | undefined;
  const turn = params.turn as { status?: string } | undefined;
  return [method, item?.type ?? status?.type ?? turn?.status]
    .filter(Boolean)
    .join(" ");
};

// Values may differ and a null matches anything, but every key must exist on both sides; union variants with different `type` are not compared.
const shapeMismatches = (
  actual: unknown,
  expected: unknown,
  path = "$",
): string[] => {
  if (actual === null || expected === null || expected === undefined) return [];
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === 0 || expected.length === 0
      ? []
      : shapeMismatches(actual[0], expected[0], `${path}[0]`);
  }
  if (typeof actual !== "object" || typeof expected !== "object") {
    return typeof actual === typeof expected
      ? []
      : [`${path}: ${typeof actual} vs ${typeof expected}`];
  }
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  if (
    typeof a.type === "string" &&
    typeof e.type === "string" &&
    a.type !== e.type
  )
    return [];
  const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
  return [...keys].flatMap((key) =>
    FREE_FORM_KEYS.has(key)
      ? []
      : !(key in a) || !(key in e)
        ? [`${path}.${key}: missing on ${key in a ? "fixture" : "render"}`]
        : shapeMismatches(a[key], e[key], `${path}.${key}`),
  );
};
