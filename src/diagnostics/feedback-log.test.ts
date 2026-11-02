import { describe, expect, test } from "bun:test";
import { loggedStarts, parseLog, selectLog } from "./feedback-log.ts";

describe("parseLog", () => {
  test("keeps known fields whose values look like what harnexus writes", () => {
    const parsed = parseLog(
      lines({
        time: "2026-10-24T09:00:00.000Z",
        pid: 41,
        event: "claude_turn",
        step: "metrics",
        model: "claude-opus-5-5[1m]",
        effort: "xhigh",
        inputTokens: 1200,
        turnMs: 3400,
      }),
    );

    expect(parsed.lines).toEqual([
      {
        time: "2026-10-24T09:00:00.000Z",
        timeMs: Date.parse("2026-10-24T09:00:00.000Z"),
        pid: 41,
        event: "claude_turn",
        fields: {
          step: "metrics",
          model: "claude-opus-5-5[1m]",
          effort: "xhigh",
          inputTokens: 1200,
          turnMs: 3400,
        },
      },
    ]);
  });

  test.each([
    {
      name: "a prompt in a field it does not know",
      line: { event: "claude_turn", step: "started", prompt: "fix my code" },
      leftOut: ["prompt"],
    },
    {
      name: "an error message in place of an error tag",
      line: {
        event: "claude_turn",
        step: "finished",
        error: "ENOENT: no such file /Users/someone/acme/notes.md",
      },
      leftOut: [],
    },
    {
      name: "a path in place of a version",
      line: { event: "codex_version", version: "/Users/someone/codex" },
      leftOut: [],
    },
    {
      name: "an email in place of a model",
      line: { event: "claude_turn", step: "metrics", model: "a@example.com" },
      leftOut: [],
    },
    {
      name: "a nested object under a known field",
      line: {
        event: "claude_turn",
        step: "refused",
        reason: { text: "private" },
      },
      leftOut: [],
    },
  ])("never passes on $name", ({ line, leftOut }) => {
    const parsed = parseLog(lines({ time: TIME, pid: 1, ...line }));

    const text = JSON.stringify(parsed.lines);
    expect(text).not.toContain("someone");
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("private");
    expect(text).not.toContain("fix my code");
    expect([...parsed.leftOutFields]).toEqual([...leftOut]);
  });

  test("keeps only the setting kinds a start line names", () => {
    const parsed = parseLog(
      lines({
        time: TIME,
        pid: 1,
        event: "bridge_started",
        commit: "0123456789ab",
        settings: {
          permissionMode: "auto",
          statePath: "/Users/someone/state",
          extra: "x",
        },
      }),
    );

    expect(parsed.lines[0]?.fields).toEqual({
      commit: "0123456789ab",
      settings: { permissionMode: "auto", statePath: "<redacted>" },
    });
  });

  test("counts lines that are not log records, but not a last line still being written", () => {
    const parsed = parseLog(
      `not json\n${JSON.stringify({ event: "x" })}\n${JSON.stringify({ time: TIME, event: "bad event!" })}\n${JSON.stringify({ time: TIME, event: "server_closed" })}\n{"time":"2026-10-24T09:0`,
    );

    expect(parsed.lines.map(({ event }) => event)).toEqual(["server_closed"]);
    expect(parsed.unreadable).toBe(3);
  });

  test("reads a line without a pid, as an older harnexus wrote it", () => {
    const parsed = parseLog(lines({ time: TIME, event: "bridge_started" }));

    expect(parsed.lines[0]?.pid).toBeNull();
  });
});

describe("selectLog", () => {
  test("adds the startup lines that bridges in the window wrote before it", () => {
    const parsed = parseLog(
      lines(
        at("08:00", 1, { event: "bridge_started", commit: "0123456789ab" }),
        at("08:00", 1, { event: "codex_version", version: "0.130.0" }),
        at("08:01", 2, { event: "bridge_started", commit: "aaaaaaaaaaaa" }),
        at("08:30", 1, { event: "claude_turn", step: "started" }),
        at("09:10", 1, { event: "claude_turn", step: "refused" }),
      ),
    );

    const selection = selectLog(parsed.lines, {
      sinceMs: Date.parse("2026-10-24T09:00:00Z"),
      untilMs: Date.parse("2026-10-24T10:00:00Z"),
      runningPids: new Set(),
      budget: 10_000,
    });

    expect(selection.context.map(eventOf)).toEqual([
      "bridge_started 1",
      "codex_version 1",
    ]);
    expect(selection.window.map(eventOf)).toEqual(["claude_turn 1"]);
  });

  test("adds the startup lines of a running bridge that wrote nothing in the window", () => {
    const parsed = parseLog(
      lines(
        at("08:00", 7, { event: "bridge_started", commit: "0123456789ab" }),
      ),
    );

    const selection = selectLog(parsed.lines, {
      sinceMs: Date.parse("2026-10-24T09:00:00Z"),
      untilMs: Date.parse("2026-10-24T10:00:00Z"),
      runningPids: new Set([7]),
      budget: 10_000,
    });

    expect(selection.context.map(eventOf)).toEqual(["bridge_started 7"]);
  });

  test("keeps the newest startup lines within their share of the budget", () => {
    const parsed = parseLog(
      lines(
        ...Array.from({ length: 100 }, (_, index) =>
          at(`08:${String(index % 60).padStart(2, "0")}`, index, {
            event: "bridge_started",
            commit: "0123456789ab",
          }),
        ),
        ...Array.from({ length: 100 }, (_, index) =>
          at("09:30", index, { event: "claude_turn", step: "refused" }),
        ),
      ),
    );

    const selection = selectLog(parsed.lines, { ...WINDOW, budget: 3000 });

    expect(selection.context.join("\n").length).toBeLessThanOrEqual(900);
    expect(selection.window.length).toBeGreaterThan(0);
    expect(
      [...selection.context, ...selection.window].join("\n").length,
    ).toBeLessThanOrEqual(3000);
  });

  test("counts relayed messages by method instead of printing them", () => {
    const parsed = parseLog(
      lines(
        at("09:01", 1, { event: "rpc_message", method: "turn/start" }),
        at("09:02", 1, { event: "rpc_message", method: "turn/start" }),
        at("09:03", 1, { event: "rpc_message", method: "thread/start" }),
      ),
    );

    const selection = selectLog(parsed.lines, WINDOW);

    expect(selection.window).toEqual([]);
    expect([...selection.messages]).toEqual([
      ["turn/start", 2],
      ["thread/start", 1],
    ]);
  });

  test("prints a repeated line once with its count", () => {
    const parsed = parseLog(
      lines(
        at("09:01", 1, { event: "claude_turn", step: "refused" }),
        at("09:02", 1, { event: "claude_turn", step: "refused" }),
        at("09:03", 1, { event: "claude_turn", step: "refused" }),
      ),
    );

    const selection = selectLog(parsed.lines, WINDOW);

    expect(selection.window).toEqual([
      '{"time":"2026-10-24T09:01:00.000Z","pid":1,"event":"claude_turn","step":"refused"} x3 until 2026-10-24T09:03:00.000Z',
    ]);
  });

  test("leaves routine lines out first when the window does not fit", () => {
    const parsed = parseLog(
      lines(
        at("09:01", 1, { event: "claude_turn", step: "refused" }),
        ...Array.from({ length: 50 }, (_, index) =>
          at("09:02", 1, {
            event: "claude_turn",
            step: "metrics",
            inputTokens: index,
          }),
        ),
        at("09:03", 1, {
          event: "claude_turn",
          step: "finished",
          status: "failed",
        }),
      ),
    );

    const selection = selectLog(parsed.lines, { ...WINDOW, budget: 600 });

    expect(selection.window[0]).toContain('"step":"refused"');
    expect(selection.window.at(-1)).toContain('"status":"failed"');
    expect(selection.window.length).toBeLessThan(52);
    expect(selection.omitted).toBe(52 - selection.window.length);
    expect(selection.window.join("\n").length).toBeLessThanOrEqual(600);
  });

  test("leaves out lines after the window's end", () => {
    const parsed = parseLog(
      lines(at("10:30", 1, { event: "claude_turn", step: "refused" })),
    );

    expect(selectLog(parsed.lines, WINDOW).window).toEqual([]);
  });
});

describe("selectLog shapes", () => {
  test("keeps the shapes of bridges in the window whenever they were recorded, and drops a path that is not a shape path", () => {
    const parsed = parseLog(
      lines(
        at("08:00", 1, {
          event: "rpc_shape",
          direction: "app_to_server",
          kind: "request",
          method: "turn/start",
          shape: "0123456789abcdef",
          paths: [
            "id:number",
            "params.text:string",
            "params.note=free text here",
          ],
        }),
        at("08:00", 2, {
          event: "rpc_shape",
          direction: "app_to_server",
          kind: "request",
          method: "turn/start",
          shape: "0123456789abcdef",
          paths: ["id:number"],
        }),
        at("09:30", 1, { event: "claude_turn", step: "refused" }),
      ),
    );

    const selection = selectLog(parsed.lines, WINDOW);

    expect(selection.shapes).toEqual([
      {
        direction: "app_to_server",
        kind: "request",
        method: "turn/start",
        paths: ["id:number", "params.text:string"],
      },
    ]);
    expect(selection.window.join("")).not.toContain("rpc_shape");
  });
});

describe("selectLog shapes of a reused pid", () => {
  test("takes only the shapes recorded since the bridge's last start and before the window's end", () => {
    const shapeLine = (clock: string, field: string) =>
      at(clock, 1, {
        event: "rpc_shape",
        direction: "app_to_server",
        kind: "request",
        method: "turn/start",
        shape: "0123456789abcdef",
        paths: [`params.${field}:string`],
      });
    const parsed = parseLog(
      lines(
        shapeLine("07:00", "older"),
        at("08:00", 1, { event: "bridge_started", commit: "0123456789ab" }),
        shapeLine("08:01", "current"),
        at("09:30", 1, { event: "claude_turn", step: "refused" }),
        shapeLine("10:30", "later"),
      ),
    );

    const selection = selectLog(parsed.lines, WINDOW);

    expect(selection.shapes.map(({ paths }) => paths)).toEqual([
      ["params.current:string"],
    ]);
  });
});

describe("selectLog shapes of an ended bridge", () => {
  test("keeps the shapes and startup lines of a bridge whose only lines in the window are relayed messages", () => {
    const parsed = parseLog(
      lines(
        at("08:00", 5, { event: "bridge_started", commit: "0123456789ab" }),
        at("09:10", 5, { event: "rpc_message", method: "turn/start" }),
        at("09:10", 5, {
          event: "rpc_shape",
          direction: "app_to_server",
          kind: "request",
          method: "turn/start",
          shape: "0123456789abcdef",
          paths: ["id:number"],
        }),
        at("10:30", 5, { event: "server_closed" }),
      ),
    );

    const selection = selectLog(parsed.lines, WINDOW);

    expect(selection.context.map(eventOf)).toEqual(["bridge_started 5"]);
    expect(selection.shapes.map(({ paths }) => paths)).toEqual([["id:number"]]);
  });
});

describe("loggedStarts", () => {
  test("keeps each bridge's last start and the Codex CLI it met", () => {
    const parsed = parseLog(
      lines(
        at("08:00", 1, { event: "bridge_started", commit: "aaaaaaaaaaaa" }),
        at("08:30", 1, {
          event: "bridge_started",
          commit: "bbbbbbbbbbbb",
          sdk: "0.3.304",
        }),
        at("08:31", 1, { event: "codex_version", version: "0.130.0" }),
        at("08:40", null, { event: "bridge_started", commit: "cccccccccccc" }),
      ),
    );

    expect(loggedStarts(parsed.lines)).toEqual([
      { pid: 1, commit: "bbbbbbbbbbbb", sdk: "0.3.304", codex: "0.130.0" },
    ]);
  });
});

const TIME = "2026-10-24T09:00:00.000Z";

const WINDOW = {
  sinceMs: Date.parse("2026-10-24T09:00:00Z"),
  untilMs: Date.parse("2026-10-24T10:00:00Z"),
  runningPids: new Set<number>(),
  budget: 10_000,
};

const lines = (...records: object[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");

const at = (clock: string, pid: number | null, record: object) => ({
  time: `2026-10-24T${clock}:00.000Z`,
  ...(pid === null ? {} : { pid }),
  ...record,
});

const eventOf = (text: string) => {
  const record = JSON.parse(text.split(" x")[0] ?? "");
  return `${record.event} ${record.pid}`;
};
