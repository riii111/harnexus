import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import type { EffortRule } from "../infra/claude/models.ts";
import type { ThreadRecord, ThreadStore } from "../infra/thread-store.ts";
import { createThreadValues } from "./thread-values.ts";

describe("ThreadValues.forgetThread", () => {
  test("drops the model and session id the store already holds, so the store's later values show", () => {
    const { values, record } = fixture();
    values.changeModel("th-1", "model-b");
    values.setSessionId("th-1", "se-2");
    record.model = "model-b";
    record.sessionId = "se-2";

    values.forgetThread("th-1", "archived");
    record.model = "model-c";
    record.sessionId = "se-3";

    expect(values.threadOf("th-1")?.model).toBe("model-c");
    expect(values.sessionIdOf("th-1")).toBe("se-3");
  });

  test("keeps a model and session id the store does not hold, since a failed save still applies", () => {
    const { values } = fixture();
    values.changeModel("th-1", "model-b");
    values.setSessionId("th-1", "se-2");

    values.forgetThread("th-1", "archived");

    expect(values.threadOf("th-1")?.model).toBe("model-b");
    expect(values.sessionIdOf("th-1")).toBe("se-2");
  });

  test("keeps the mode, the picked mark and the side chat of an archived thread", () => {
    const { values } = fixture();
    values.selectMode("th-1", "plan");
    values.noteSideChat("th-1", { instructions: "aside", reference: null });

    values.forgetThread("th-1", "archived");

    expect(values.modeOf("th-1")).toBe("plan");
    expect(values.instructionsOf("th-1")).toBe("aside");
  });

  test("drops everything a deleted thread held, even what the store lacks", () => {
    const { values } = fixture();
    values.changeModel("th-1", "model-b");
    values.setSessionId("th-1", "se-2");
    values.selectMode("th-1", "plan");
    values.noteSideChat("th-1", { instructions: "aside", reference: null });

    values.forgetThread("th-1", "deleted");

    expect(values.threadOf("th-1")?.model).toBe("model-a");
    expect(values.sessionIdOf("th-1")).toBe("se-1");
    expect(values.modeOf("th-1")).toBeUndefined();
    expect(values.instructionsOf("th-1")).toBeNull();
  });
});

const fixture = () => {
  const record = {
    threadId: "th-1",
    sessionId: "se-1",
    model: "model-a",
    effort: null,
    worktree: "/work/tree",
    messageIds: [],
    runState: "idle",
  } as ThreadRecord & { model: string; sessionId: string | null };
  const writable = record as { model: string; sessionId: string | null };
  const store = {
    get: (threadId: string) => (threadId === "th-1" ? record : undefined),
    setModel: async () => Result.ok(),
    setEffort: async () => Result.ok(),
    setSessionId: async () => Result.ok(),
  } as unknown as ThreadStore;
  const values = createThreadValues(
    store,
    () => {},
    (() => null) as EffortRule,
  );
  return { values, record: writable };
};
