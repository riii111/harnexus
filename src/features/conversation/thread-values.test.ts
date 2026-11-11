import { describe, expect, test } from "bun:test";

import { Result } from "better-result";

import type { EffortRule } from "../../infra/claude/models.ts";
import type { ThreadRecord, ThreadStore } from "../../infra/thread-store.ts";
import { createThreadValues } from "./thread-values.ts";

describe("ThreadValues thread recognition", () => {
  test("recognizes an adopted thread while only a stored thread is saved", () => {
    const { values } = fixture();
    values.adopt("th-new", { model: "model-a", cwd: "/work/tree" });

    expect(values.isClaudeThread("th-new")).toBe(true);
    expect(values.isSavedClaudeThread("th-new")).toBe(false);
    expect(values.isClaudeThread("th-1")).toBe(true);
    expect(values.isSavedClaudeThread("th-1")).toBe(true);
    expect(values.isClaudeThread("unknown")).toBe(false);
    expect(values.isSavedClaudeThread("unknown")).toBe(false);
  });
});

describe("ThreadValues.forgetThread", () => {
  test("drops the model and session id the store already holds, so the store's later values show", async () => {
    const { values, record } = fixture();
    values.changeModel("th-1", "model-b");
    await values.setSessionId("th-1", "se-2");
    record.model = "model-b";
    record.sessionId = "se-2";

    values.forgetThread("th-1", "archived");
    record.model = "model-c";
    record.sessionId = "se-3";

    expect(values.threadOf("th-1")?.model).toBe("model-c");
    expect(values.sessionIdOf("th-1")).toBe("se-3");
  });

  test("keeps a model and session id the store does not hold, since a failed save still applies", async () => {
    const { values } = fixture();
    values.changeModel("th-1", "model-b");
    await values.setSessionId("th-1", "se-2");

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

  test("drops everything a deleted thread held, even what the store lacks", async () => {
    const { values } = fixture();
    values.changeModel("th-1", "model-b");
    await values.setSessionId("th-1", "se-2");
    values.selectMode("th-1", "plan");
    values.noteSideChat("th-1", { instructions: "aside", reference: null });

    values.forgetThread("th-1", "deleted");

    expect(values.threadOf("th-1")?.model).toBe("model-a");
    expect(values.sessionIdOf("th-1")).toBe("se-1");
    expect(values.modeOf("th-1")).toBeUndefined();
    expect(values.instructionsOf("th-1")).toBeNull();
  });
});

describe("ThreadValues.setCloudArchived", () => {
  test("saves the mark on a Cloud thread only when it changes it", async () => {
    const { values, saved, record } = fixture({ cloud: true });

    await values.setCloudArchived("th-1", true);
    record.archived = true;
    await values.setCloudArchived("th-1", true);
    await values.setCloudArchived("th-1", false);

    expect(saved).toEqual([true, false]);
  });

  test("saves nothing for a thread with no Cloud link", async () => {
    const { values, saved } = fixture({ cloud: false });

    await values.setCloudArchived("th-1", true);

    expect(saved).toEqual([]);
  });

  test("logs a mark that could not be saved, since the thread stays copied until the next read", async () => {
    const { values, events } = fixture({ cloud: true, saveFails: true });

    await values.setCloudArchived("th-1", true);

    expect(events).toEqual([
      {
        event: "claude_turn",
        step: "archive_not_saved",
        error: "ThreadNotFound",
      },
    ]);
  });
});

const fixture = ({
  cloud = false,
  saveFails = false,
}: { cloud?: boolean; saveFails?: boolean } = {}) => {
  const record = {
    threadId: "th-1",
    sessionId: "se-1",
    model: "model-a",
    effort: null,
    worktree: "/work/tree",
    messageIds: [],
    runState: "idle",
  } as ThreadRecord & { model: string; sessionId: string | null };
  const writable = record as {
    model: string;
    sessionId: string | null;
    archived?: true;
  };
  const saved: boolean[] = [];
  const events: unknown[] = [];
  const store = {
    get: (threadId: string) =>
      threadId === "th-1"
        ? {
            ...record,
            ...(cloud && { cloud: { sessionId: "cs", shown: null } }),
            ...(writable.archived && { archived: true }),
          }
        : undefined,
    setCloudArchived: async (_threadId: string, archived: boolean) => {
      saved.push(archived);
      return saveFails ? Result.err({ _tag: "ThreadNotFound" }) : Result.ok();
    },
    setModel: async () => Result.ok(),
    setEffort: async () => Result.ok(),
    setSessionId: async () => Result.ok(),
  } as unknown as ThreadStore;
  const values = createThreadValues(
    store,
    (event) => events.push(event),
    (() => null) as EffortRule,
  );
  return { values, record: writable, saved, events };
};
