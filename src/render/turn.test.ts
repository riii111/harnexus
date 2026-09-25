import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AppNotification, ThreadItem } from "./protocol.ts";
import {
  finishTurn,
  markInterrupting,
  type Rendered,
  renderSdkMessage,
  renderUserInput,
  startTurn,
} from "./turn.ts";

describe("text", () => {
  test("streams text as deltas and reports it as the final answer", () => {
    const out = run([
      ...streamedText("msg-1", ["Hel", "lo"], "end_turn"),
      success(),
    ]);

    expect(deltas(out)).toEqual(["Hel", "lo"]);
    const answer = completedItems(out).find(
      (item) => item.type === "agentMessage",
    );
    expect(answer).toMatchObject({ text: "Hello", phase: "final_answer" });
    expect(turnCompleted(out)).toMatchObject({
      status: "completed",
      items: [answer],
    });
  });

  test("closes text before a tool call as commentary ahead of the tool item", () => {
    const out = run([
      ...streamedText("msg-1", ["let me look"], null),
      assistant("msg-1", [toolUse("tool-1", "Bash", { command: "ls" })]),
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      }),
      toolResult("tool-1", "a.txt", false),
      ...streamedText("msg-2", ["done"], "end_turn"),
      success(),
    ]);

    expect(itemEvents(out)).toEqual([
      "item/started userMessage",
      "item/completed userMessage",
      "item/started agentMessage",
      "item/completed agentMessage",
      "item/started commandExecution",
      "item/completed commandExecution",
      "item/started agentMessage",
      "item/completed agentMessage",
    ]);
    expect(completedItems(out)[1]).toMatchObject({ phase: "commentary" });
    expect(turnCompleted(out)?.items).toMatchObject([{ text: "done" }]);
  });

  test("renders each block once whether or not the stream carried it", () => {
    const out = run([
      ...streamedText("msg-1", ["streamed"], null),
      assistant("msg-1", [{ type: "text", text: "streamed" }]),
      assistant("msg-1", [{ type: "text", text: "not streamed" }]),
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      }),
      success(),
    ]);

    expect(messageTexts(out)).toEqual(["streamed", "not streamed"]);
  });

  test("closes a block whose message was abandoned for a retry", () => {
    const out = run([
      streamEvent({ type: "message_start", message: { id: "msg-1" } }),
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "cut" },
      }),
      ...streamedText("msg-2", ["retried"], "end_turn"),
      success(),
    ]);

    expect(unpaired(out)).toEqual([]);
    expect(messageTexts(out)).toEqual(["cut", "retried"]);
  });

  test("ignores subagent messages", () => {
    const out = run([
      {
        ...streamEvent({ type: "message_start", message: { id: "sub" } }),
        parent_tool_use_id: "tool-1",
      },
      {
        ...streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        }),
        parent_tool_use_id: "tool-1",
      },
      {
        ...assistant("sub", [{ type: "text", text: "inner" }]),
        parent_tool_use_id: "tool-1",
      },
      success(),
    ]);

    expect(completedItems(out).map((item) => item.type)).toEqual([
      "userMessage",
    ]);
  });
});

describe("tools", () => {
  test("maps Bash to a command execution and reads a failed exit code", () => {
    const out = run([
      assistant("msg-1", [toolUse("tool-1", "Bash", { command: "false" })]),
      toolResult("tool-1", "Exit code 2\nboom", true),
      success(),
    ]);

    expect(completedTool(out)).toMatchObject({
      type: "commandExecution",
      command: "false",
      cwd: "/fixture/work",
      status: "failed",
      aggregatedOutput: "Exit code 2\nboom",
      exitCode: 2,
    });
  });

  test("maps Edit to a file change and replaces the proposed diff with the applied hunks", () => {
    const out = run([
      assistant("msg-1", [
        toolUse("tool-1", "Edit", {
          file_path: "/fixture/work/a.txt",
          old_string: "old\n",
          new_string: "new\n",
        }),
      ]),
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
      changes: [
        { kind: { type: "update" }, diff: "@@ -1,1 +1,1 @@\n-old\n+new\n" },
      ],
    });
    expect(completedTool(out)).toMatchObject({
      type: "fileChange",
      changes: [
        { path: "/fixture/work/a.txt", diff: "@@ -3,1 +3,1 @@\n-old\n+new\n" },
      ],
      status: "completed",
    });
  });

  test("maps Write of a new file to an added file", () => {
    const out = run([
      assistant("msg-1", [
        toolUse("tool-1", "Write", {
          file_path: "/fixture/work/b.txt",
          content: "hi\n",
        }),
      ]),
      toolResult("tool-1", "created", false, {
        type: "create",
        filePath: "/fixture/work/b.txt",
        content: "hi\n",
      }),
      success(),
    ]);

    expect(completedTool(out)).toMatchObject({
      changes: [{ kind: { type: "add" }, diff: "hi\n" }],
      status: "completed",
    });
  });

  test("shows MCP and other Claude tools as MCP tool calls with their server", () => {
    const out = run([
      assistant("msg-1", [
        toolUse("tool-1", "mcp__codex_link__read_thread", { threadId: "th-2" }),
        toolUse("tool-2", "Read", { file_path: "/a" }),
      ]),
      toolResult("tool-1", [{ type: "text", text: "body" }], false),
      toolResult("tool-2", "no such file", true),
      success(),
    ]);

    expect(completedItems(out).filter(isTool)).toMatchObject([
      {
        type: "mcpToolCall",
        server: "codex_link",
        tool: "read_thread",
        status: "completed",
      },
      {
        type: "mcpToolCall",
        server: "claude",
        tool: "Read",
        status: "failed",
        error: { message: "no such file" },
      },
    ]);
  });

  test("marks a tool the permission check denied as declined", () => {
    const out = run([
      assistant("msg-1", [toolUse("tool-1", "Bash", { command: "rm -rf x" })]),
      {
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "tool-1",
      },
      toolResult("tool-1", "denied", true),
      success(),
    ]);

    expect(completedTool(out)).toMatchObject({ status: "declined" });
  });

  test("renders a repeated tool call only once", () => {
    const call = assistant("msg-1", [
      toolUse("tool-1", "Bash", { command: "ls" }),
    ]);
    const out = run([call, toolResult("tool-1", "a", false), call, success()]);

    expect(completedItems(out).filter(isTool)).toHaveLength(1);
    expect(unpaired(out)).toEqual([]);
  });
});

describe("turn end", () => {
  test("fails the turn once with the result error, not as an answer", () => {
    const out = run([
      ...streamedText("msg-1", ["partial"], null),
      {
        ...assistant(
          "msg-2",
          [{ type: "text", text: "API Error: down" }],
          "stop_sequence",
        ),
        error: "server_error",
      },
      result({
        subtype: "error_during_execution",
        is_error: true,
        errors: ["api down"],
      }),
    ]);

    expect(
      notificationsOf(out, "error").map((n) => n.params.error.message),
    ).toEqual(["api down"]);
    expect(messageTexts(out)).toEqual(["partial"]);
    expect(turnCompleted(out)).toMatchObject({
      status: "failed",
      items: [],
      error: { message: "api down" },
    });
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

  test("ends an interrupted turn as interrupted even when the SDK result reports an error", () => {
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
      assistant("msg-2", [toolUse("tool-1", "Bash", { command: "sleep 9" })]),
    ]) {
      rendered = renderSdkMessage(rendered.state, sdk(message), NOW);
      all.push(...rendered.notifications);
    }
    const state = markInterrupting(rendered.state);
    rendered = renderSdkMessage(
      state,
      sdk(result({ subtype: "error_during_execution", is_error: true })),
      NOW,
    );
    all.push(...rendered.notifications);

    const out = { notifications: all };
    expect(notificationsOf(out, "error")).toEqual([]);
    expect(turnCompleted(out)).toMatchObject({
      status: "interrupted",
      items: [],
    });
    expect(unpaired(out)).toEqual([]);
    expect(completedTool(out)).toMatchObject({ status: "failed" });
    expect(
      renderSdkMessage(rendered.state, sdk(success()), NOW).notifications,
    ).toEqual([]);
  });
});

describe("state", () => {
  test("replays the same notifications from the same state", () => {
    const { state } = begin();
    const messages = [
      ...streamedText("msg-1", ["a"], null),
      assistant("msg-1", [toolUse("tool-1", "Bash", { command: "ls" })]),
      toolResult("tool-1", "x", false),
      success(),
    ];
    const replay = () => {
      let current = state;
      return messages.flatMap((message) => {
        const next = renderSdkMessage(current, sdk(message), NOW);
        current = next.state;
        return next.notifications;
      });
    };

    expect(replay()).toEqual(replay());
  });
});

describe("fixture shapes", () => {
  test("every notification carries the fields and value types of the app-server fixtures", () => {
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
        assistant("msg-1", [
          toolUse("tool-1", "Bash", { command: "ls" }),
          toolUse("tool-2", "Edit", {
            file_path: "/a",
            old_string: "o",
            new_string: "n",
          }),
          toolUse("tool-3", "mcp__s__t", {}),
        ]),
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

    const mismatches = outputs
      .flatMap((out) => out.notifications)
      .flatMap((notification) => {
        const key = shapeKey(notification);
        const sample = samples.get(key);
        if (sample === undefined) return [`${key}: no fixture`];
        return shapeMismatches(notification, sample)
          .map((path) => `${key} ${path}`)
          .filter(
            (mismatch) => !NULLABLE_PATHS.has(mismatch.split(":")[0] ?? ""),
          );
      });
    expect(mismatches).toEqual([]);
  });

  test("an interrupted turn follows the recorded notification order", () => {
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
    all.push(
      ...finishTurn(rendered.state, { status: "interrupted" }, NOW)
        .notifications,
    );

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
  });
});

const NOW = 1700000000500;
const FIXTURE_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "test",
  "fixtures",
  "app-server",
);
// Tool arguments are whatever the model passed, so they have no fixed shape.
const FREE_FORM_KEYS = new Set(["arguments"]);
// The bridge learns a message's phase only after it finishes streaming, and the recorded command was declined, so these fixture values differ from a normal run.
const NULLABLE_PATHS = new Set([
  "item/started agentMessage $.params.item.phase",
  "item/completed commandExecution $.params.item.aggregatedOutput",
  "item/completed commandExecution $.params.item.exitCode",
  "item/completed commandExecution $.params.item.durationMs",
]);

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
  stopReason: string | null = null,
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

type Output = { notifications: AppNotification[] };

const notificationsOf = <M extends AppNotification["method"]>(
  out: Output,
  method: M,
) =>
  out.notifications.filter(
    (n): n is Extract<AppNotification, { method: M }> => n.method === method,
  );

const deltas = (out: Output) =>
  notificationsOf(out, "item/agentMessage/delta").map((n) => n.params.delta);

const completedItems = (out: Output) =>
  notificationsOf(out, "item/completed").map((n) => n.params.item);

const messageTexts = (out: Output) =>
  completedItems(out).flatMap((item) =>
    item.type === "agentMessage" ? [item.text] : [],
  );

const startedTool = (out: Output) =>
  notificationsOf(out, "item/started")
    .map((n) => n.params.item)
    .find(isTool);

const completedTool = (out: Output) => completedItems(out).find(isTool);

const isTool = (item: ThreadItem) =>
  item.type === "commandExecution" ||
  item.type === "fileChange" ||
  item.type === "mcpToolCall";

const turnCompleted = (out: Output) =>
  notificationsOf(out, "turn/completed")[0]?.params.turn;

const itemEvents = (out: Output) =>
  out.notifications
    .filter((n) => n.method === "item/started" || n.method === "item/completed")
    .map((n) => `${n.method} ${(n.params as { item: ThreadItem }).item.type}`);

const unpaired = (out: Output) => {
  const started = notificationsOf(out, "item/started").map(
    (n) => n.params.item.id,
  );
  const completed = notificationsOf(out, "item/completed").map(
    (n) => n.params.item.id,
  );
  return [
    ...started.filter(
      (id) => completed.filter((done) => done === id).length !== 1,
    ),
    ...completed.filter((id) => !started.includes(id)),
  ];
};

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

// Keys, value types and nulls must match; union variants with a different `type` are not compared.
const shapeMismatches = (
  actual: unknown,
  expected: unknown,
  path = "$",
): string[] => {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === 0 || expected.length === 0
      ? []
      : shapeMismatches(actual[0], expected[0], `${path}[0]`);
  }
  if (actual === null || expected === null) {
    return actual === expected
      ? []
      : [`${path}: ${kindOf(actual)} vs ${kindOf(expected)}`];
  }
  if (typeof actual !== "object" || typeof expected !== "object") {
    return typeof actual === typeof expected
      ? []
      : [`${path}: ${kindOf(actual)} vs ${kindOf(expected)}`];
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
  return [...keys].flatMap((key) => {
    if (FREE_FORM_KEYS.has(key)) return [];
    if (!(key in a) || !(key in e))
      return [`${path}.${key}: missing on ${key in a ? "fixture" : "render"}`];
    return shapeMismatches(a[key], e[key], `${path}.${key}`);
  });
};

const kindOf = (value: unknown) => (value === null ? "null" : typeof value);
