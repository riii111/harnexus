import { describe, expect, test } from "bun:test";
import {
  prompt,
  reply,
  text,
  toolResult,
  toolUse,
} from "../../presentation/testing/session-record.ts";
import { childSessionsIn } from "./cloud-children.ts";

const CHILD = "session_01NfjPqs5GNSgknfAaJ3mdYA";
const CREATE = "mcp__claude-code-remote__create_session";
const created = (id: string, title = "[riii111/harnexus#178]") =>
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
      { sessionId: CHILD, title: "[riii111/harnexus#178]" },
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
