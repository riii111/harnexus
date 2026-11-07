import { describe, expect, test } from "bun:test";

import {
  prompt,
  reply,
  text,
  thinking,
  toolResult,
  toolUse,
} from "../../testing/session-record.ts";
import { childSessionsIn, waitingIn } from "./children.ts";

const CHILD = "session_01ChildFixtureSession000";
const CREATE = "mcp__claude-code-remote__create_session";
const created = (id: string, title = "[owner/repo#1]") =>
  JSON.stringify({
    ccr: { id, title, session_status: "SESSION_STATUS_PENDING" },
  });

describe("childSessionsIn", () => {
  test("finds a session a create_session call started, with its title", () => {
    const records = [
      prompt("p1", "start a worker"),
      reply("a1", "m1", toolUse("t1", CREATE, { prompt: "go" }), "tool_use"),
      toolResult("r1", "t1", created(CHILD)),
    ];

    expect(childSessionsIn(records)).toEqual([
      { sessionId: CHILD, title: "[owner/repo#1]" },
    ]);
  });

  test("ignores a session id that is only written or quoted, or a failed call", () => {
    const records = [
      reply("a1", "m1", text(`see ${created(CHILD)}`), "end_turn"),
      reply("a2", "m2", toolUse("t1", "Bash", {}), "tool_use"),
      toolResult("r1", "t1", created(CHILD)),
      reply("a3", "m3", toolUse("t2", CREATE, {}), "tool_use"),
      toolResult("r2", "t2", created(CHILD), true),
    ];

    expect(childSessionsIn(records)).toEqual([]);
  });

  test("takes a result after from whose call came before it", () => {
    const records = [
      reply("a1", "m1", toolUse("t1", CREATE, {}), "tool_use"),
      toolResult("r1", "t1", created(CHILD)),
    ];

    expect(childSessionsIn(records, 1)).toHaveLength(1);
    expect(childSessionsIn(records, 2)).toEqual([]);
  });

  test("names each session once", () => {
    const records = [
      reply("a1", "m1", toolUse("t1", CREATE, {}), "tool_use"),
      toolResult("r1", "t1", created(CHILD)),
      reply("a2", "m2", toolUse("t2", CREATE, {}), "tool_use"),
      toolResult("r2", "t2", created(CHILD, "")),
    ];

    expect(childSessionsIn(records)).toHaveLength(1);
  });
});

describe("waitingIn", () => {
  const SEND_LATER = "mcp__claude-code-remote__send_later";
  const DELETE = "mcp__claude-code-remote__delete_trigger";
  const started = [
    prompt("p1", "start a worker"),
    reply("a1", "m1", toolUse("t1", CREATE, { prompt: "go" }), "tool_use"),
    toolResult("r1", "t1", created(CHILD)),
    reply("a2", "m2", text("waiting for the worker"), "end_turn"),
  ];
  const background = [
    prompt("p1", "run the checks"),
    reply(
      "a1",
      "m1",
      toolUse("t1", "Bash", {
        command: "bun test",
        run_in_background: true,
      }),
      "tool_use",
    ),
    toolResult(
      "r1",
      "t1",
      "Command running in background with ID: b42t71ybw. Output is being written to: /tmp/tasks/b42t71ybw.output.",
    ),
    reply(
      "a2",
      "m2",
      text("Started the checks; they take a minute or two."),
      "end_turn",
    ),
  ];
  const scheduled = [
    prompt("p1", "check later", "2026-11-01T00:00:00Z"),
    reply(
      "a1",
      "m1",
      toolUse("t1", SEND_LATER, { delay_minutes: 30, message: "check" }),
      "tool_use",
      "2026-11-01T00:00:00Z",
    ),
    toolResult("r1", "t1", '{"trigger_id":"trig_01Abc"}'),
    reply("a2", "m2", text("will check later"), "end_turn"),
  ];

  const agent = (result: string) => [
    prompt("p1", "look it up"),
    reply("a1", "m1", toolUse("t1", "Agent", { prompt: "fetch" }), "tool_use"),
    toolResult("r1", "t1", result),
    reply("a2", "m2", text("here is what it found"), "end_turn"),
  ];

  test.each([
    {
      name: "does not wait for a session it started, which tells it of its work itself",
      records: started,
      expected: false,
    },
    {
      name: "waits for a message it scheduled to itself that has not come",
      records: scheduled,
      expected: true,
    },
    {
      name: "stops waiting once the scheduled message came",
      records: [
        ...scheduled,
        prompt("p2", "check", "2026-11-01T00:30:00Z"),
        reply("a3", "m3", text("checked"), "end_turn"),
      ],
      expected: false,
    },
    {
      name: "keeps waiting past a message that came before the scheduled one was due",
      records: [...scheduled, prompt("p2", "hi", "2026-11-01T00:05:00Z")],
      expected: true,
    },
    {
      name: "keeps waiting past a message taken before it scheduled one a minute later",
      records: [
        prompt("p0", "hi", "2026-11-01T00:00:00Z"),
        reply(
          "a0",
          "m0",
          toolUse("t0", SEND_LATER, { delay_minutes: 1, message: "check" }),
          "tool_use",
          "2026-11-01T00:00:00Z",
        ),
        toolResult("r0", "t0", '{"trigger_id":"trig_01Abc"}'),
        reply("a1", "m1", text("will check"), "end_turn"),
      ],
      expected: true,
    },
    {
      name: "keeps waiting past another message that came when the scheduled one was due",
      records: [...scheduled, prompt("p2", "hi", "2026-11-01T00:30:00Z")],
      expected: true,
    },
    {
      name: "keeps waiting past a message the user typed that only mentions what was scheduled",
      records: [
        ...scheduled,
        prompt("p2", "I will check with Alex", "2026-11-01T00:30:00Z"),
      ],
      expected: true,
    },
    {
      name: "stops waiting once the session read the scheduled message among its notifications",
      records: [
        ...scheduled,
        reply(
          "a3",
          "m3",
          toolUse("t2", "ReadNotifications", {}),
          "tool_use",
          "2026-11-01T00:30:00Z",
        ),
        toolResult(
          "r2",
          "t2",
          "--- Notification 1 of 1 · origin: scheduled trigger ---\ncheck",
          false,
          "2026-11-01T00:30:01Z",
        ),
      ],
      expected: false,
    },
    {
      name: "waits for a command it left running in the background",
      records: background,
      expected: true,
    },
    {
      name: "waits for an agent it left running in the background",
      records: agent(
        "Async agent launched successfully.\nagentId: a43d9079443239dbf (internal ID)\nThe agent is working in the background.",
      ),
      expected: true,
    },
    {
      name: "does not wait for an agent that ran in the foreground, whose result names it so it can be messaged again",
      records: agent(
        "This agent's report was delivered to you as a message from \"a43d9079443239dbf\" (its SubagentHandback call).\nagentId: a43d9079443239dbf (use SendMessage with to: 'a43d9079443239dbf' to continue this agent)",
      ),
      expected: false,
    },
    {
      name: "does not wait for work a file it read only mentions",
      records: [
        prompt("p1", "look"),
        reply("a1", "m1", toolUse("t1", "Read", {}), "tool_use"),
        toolResult(
          "r1",
          "t1",
          "Command running in background with ID: b42t71ybw.\nagentId: a43d9079443239dbf",
        ),
        reply("a2", "m2", text("read it"), "end_turn"),
      ],
      expected: false,
    },
    {
      name: "keeps waiting while the session only mentions the background work, such as checking on it",
      records: [
        ...background,
        prompt("p2", "how is it"),
        reply(
          "a3",
          "m3",
          text("Review b42t71ybw is still running."),
          "end_turn",
        ),
      ],
      expected: true,
    },
    {
      name: "stops waiting once the notice of the background work's end comes",
      records: [
        ...background,
        prompt(
          "p2",
          "<task-notification>\n<task-id>b42t71ybw</task-id>\n<status>completed</status>\n</task-notification>",
        ),
        reply("a4", "m4", text("LGTM"), "end_turn"),
      ],
      expected: false,
    },
    {
      name: "stops waiting once a turn opens without a prompt, as one the notice of the background work's end opens while the session waits",
      records: [
        ...background,
        reply("a3", "m3", toolUse("t2", "Read", {}), "tool_use"),
        toolResult("r2", "t2", "LGTM"),
        reply("a4", "m4", text("LGTM"), "end_turn"),
      ],
      expected: false,
    },
    {
      name: "keeps waiting when the reply that ended the turn goes on in a record of the same message",
      records: [
        ...background.slice(0, -1),
        reply("a2", "m2", thinking("done for now"), "end_turn"),
        reply("a3", "m2", text("Asked Codex."), "end_turn"),
      ],
      expected: true,
    },
    {
      name: "keeps waiting for background work started after the turn that opened without a prompt",
      records: [
        ...background,
        reply(
          "a3",
          "m3",
          toolUse("t2", "Bash", { run_in_background: true }),
          "tool_use",
        ),
        toolResult(
          "r2",
          "t2",
          "Command running in background with ID: c53u82zcx. Output is being written to: /tmp/tasks/c53u82zcx.output.",
        ),
        reply("a4", "m4", text("Asked again."), "end_turn"),
      ],
      expected: true,
    },
    {
      name: "stops waiting for a message it cancelled",
      records: [
        ...scheduled,
        reply(
          "a3",
          "m3",
          toolUse("t2", DELETE, { trigger_id: "trig_01Abc" }),
          "tool_use",
        ),
        toolResult("r2", "t2", "deleted"),
      ],
      expected: false,
    },
  ])("$name", ({ records, expected }) => {
    expect(waitingIn(records)).toBe(expected);
  });
});
