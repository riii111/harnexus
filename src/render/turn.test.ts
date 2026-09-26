import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AppNotification, ThreadItem } from "./protocol.ts";
import {
  continueAfterResult,
  markInterrupting,
  markToolDeclined,
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
      toolResult(
        "tool-1",
        [
          { type: "text", text: "body" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
        false,
      ),
      toolResult("tool-2", "no such file", true),
      success(),
    ]);

    expect(completedItems(out).filter(isTool)).toMatchObject([
      {
        type: "mcpToolCall",
        server: "codex_link",
        tool: "read_thread",
        arguments: { threadId: "th-2" },
        status: "completed",
        result: {
          content: [
            { type: "text", text: "body" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        },
        error: null,
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

  test("marks tools refused by the permission callback or the SDK as declined", () => {
    let { state } = begin();
    const all: AppNotification[] = [];
    // The callback may refuse a tool before its item starts.
    state = markToolDeclined(state, "tool-1");
    for (const message of [
      assistant("msg-1", [
        toolUse("tool-1", "Bash", { command: "rm -rf x" }),
        toolUse("tool-2", "Edit", {
          file_path: "/a",
          old_string: "o",
          new_string: "n",
        }),
      ]),
      {
        type: "system",
        subtype: "permission_denied",
        tool_name: "Edit",
        tool_use_id: "tool-2",
      },
      toolResult("tool-1", "denied", true),
      toolResult("tool-2", "denied", true),
    ]) {
      const next = renderSdkMessage(state, sdk(message), NOW);
      state = next.state;
      all.push(...next.notifications);
    }

    expect(
      completedItems({ notifications: all }).map((item) =>
        "status" in item ? item.status : null,
      ),
    ).toEqual(["declined", "declined"]);
  });

  test("completes a tool again as declined when only the result reports its denial", () => {
    const out = run([
      assistant("msg-1", [
        toolUse("tool-1", "Edit", {
          file_path: "/secret/a",
          old_string: "o",
          new_string: "n",
        }),
      ]),
      toolResult("tool-1", "denied by rule", true),
      result({
        subtype: "success",
        is_error: false,
        result: "done",
        permission_denials: [
          { tool_name: "Edit", tool_use_id: "tool-1", tool_input: {} },
        ],
      }),
    ]);

    expect(
      completedItems(out).flatMap((item) =>
        item.type === "fileChange" ? [item.status] : [],
      ),
    ).toEqual(["failed", "declined"]);
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

describe("continueAfterResult", () => {
  test("corrects denials and keeps the turn open for the Claude turn that follows", () => {
    const before = run([
      assistant("msg-1", [
        toolUse("tool-1", "Edit", {
          file_path: "/secret/a",
          old_string: "o",
          new_string: "n",
        }),
      ]),
      toolResult("tool-1", "denied by rule", true),
      ...streamedText("msg-2", ["first"], "end_turn"),
    ]);

    const continued = continueAfterResult(
      before.state,
      result({
        subtype: "success",
        is_error: false,
        result: "done",
        permission_denials: [
          { tool_name: "Edit", tool_use_id: "tool-1", tool_input: {} },
        ],
      }) as unknown as SDKResultMessage,
      NOW,
    );
    const after = renderSdkMessage(
      continued.state,
      sdk(success()),
      NOW,
    ).notifications;

    expect(continued.state.finished).toBe(false);
    expect(
      completedItems(continued).flatMap((item) =>
        item.type === "fileChange" ? [item.status] : [],
      ),
    ).toEqual(["declined"]);
    expect(turnCompleted(continued)).toBeUndefined();
    expect(turnCompleted({ notifications: after })).toMatchObject({
      status: "completed",
    });
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

describe("recorded sessions", () => {
  test("renders a failed turn with thinking, an edit and an MCP tool as recorded", () => {
    const out = runRecorded("tu-fixture-3", [
      streamEvent({ type: "message_start", message: { id: "msg-1" } }),
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: `${SECRET} thought` },
      }),
      streamEvent({ type: "content_block_stop", index: 0 }),
      assistant("msg-1", [
        toolUse("tool-1", "Edit", {
          file_path: "/fixture/work/a.txt",
          old_string: `${SECRET} old`,
          new_string: `${SECRET} new`,
        }),
      ]),
      toolResult("tool-1", "updated", false, {
        filePath: "/fixture/work/a.txt",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [`-${SECRET} old`, `+${SECRET} new`],
          },
        ],
      }),
      assistant("msg-1", [
        toolUse("tool-2", "mcp__fixture__lookup", { query: SECRET }),
      ]),
      toolResult("tool-2", `${SECRET} tool error`, true),
      result({
        subtype: "error_during_execution",
        is_error: true,
        errors: [`${SECRET} turn error`],
      }),
    ]);

    expect(normalize(out)).toEqual(
      normalize(recordedNotifications("turn-failed-with-edits.jsonl")),
    );
  });

  test("renders a user message as recorded", () => {
    const { state } = startTurn({
      threadId: "th-fixture-1",
      turnId: "tu-fixture-1",
      cwd: "/fixture/work",
      now: NOW,
    });
    const out = renderUserInput(
      state,
      [{ type: "text", text: `${SECRET} prompt`, text_elements: [] }],
      null,
      NOW,
    );

    expect(normalize(out.notifications)).toEqual(
      normalize(
        recordedNotifications("turn-with-tools.jsonl").filter(
          (n) => n.params.item?.type === "userMessage",
        ),
      ),
    );
  });

  test("renders an interrupted turn as recorded except for the message it closes", () => {
    let { state, notifications } = startTurn({
      threadId: "th-fixture-1",
      turnId: "tu-fixture-2",
      cwd: "/fixture/work",
      now: NOW,
    });
    const all = [...notifications];
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
        delta: { type: "text_delta", text: `${SECRET} 1` },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `${SECRET} 2` },
      }),
    ]) {
      ({ state, notifications } = renderSdkMessage(state, sdk(message), NOW));
      all.push(...notifications);
    }
    all.push(
      ...renderSdkMessage(
        markInterrupting(state),
        sdk(result({ subtype: "error_during_execution", is_error: true })),
        NOW,
      ).notifications,
    );

    // The bridge learns the phase only after streaming, and closes the message Codex leaves open.
    const recorded = recordedNotifications("steer-and-interrupt.jsonl");
    const [active, started, message, ...rest] = recorded;
    const item = { ...message?.params.item, phase: null };
    expect(normalize(all)).toEqual(
      normalize([
        active,
        started,
        { ...message, params: { ...message?.params, item } },
        ...rest.slice(0, 2),
        {
          method: "item/completed",
          params: {
            item: { ...item, text: `${SECRET} 1${SECRET} 2` },
            threadId: "th-fixture-1",
            turnId: "tu-fixture-2",
            completedAtMs: 0,
          },
          emittedAtMs: 0,
        },
        ...rest.slice(2),
      ]),
    );
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
const SECRET = "sk-fixture-secret";
const TIME_KEYS = new Set([
  "emittedAtMs",
  "startedAtMs",
  "completedAtMs",
  "startedAt",
  "completedAt",
  "durationMs",
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

const runRecorded = (turnId: string, messages: object[]) => {
  let { state, notifications } = startTurn({
    threadId: "th-fixture-1",
    turnId,
    cwd: "/fixture/work",
    now: NOW,
  });
  const all = [...notifications];
  for (const message of messages) {
    ({ state, notifications } = renderSdkMessage(state, sdk(message), NOW));
    all.push(...notifications);
  }
  return all;
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

const result = (fields: object) => ({
  type: "result",
  errors: [],
  permission_denials: [],
  ...fields,
});

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

const recordedNotifications = (name: string): Recorded[] =>
  readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter(
      (record) =>
        record.direction === "server_to_app" &&
        record.message.method !== undefined &&
        record.message.id === undefined,
    )
    .map((record) => record.message);

// Times come from the clock and item ids from each side's numbering, so both are replaced in order of appearance.
const normalize = (notifications: unknown[]) => {
  const ids = new Map<string, string>();
  const walk = (value: unknown, key: string | null): unknown => {
    if (Array.isArray(value)) return value.map((entry) => walk(entry, null));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, walk(v, k)]),
      );
    }
    if (key !== null && TIME_KEYS.has(key) && typeof value === "number") {
      return 0;
    }
    if ((key === "id" || key === "itemId") && typeof value === "string") {
      if (!ids.has(value)) ids.set(value, `id-${ids.size + 1}`);
      return ids.get(value);
    }
    return value;
  };
  return notifications.map((notification) => walk(notification, null));
};

type Recorded = {
  method: string;
  params: { item?: Record<string, unknown> } & Record<string, unknown>;
  emittedAtMs: number;
};
