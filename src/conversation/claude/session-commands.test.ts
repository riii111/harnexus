import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeClaude } from "../../infra/claude/testing/fake-claude.ts";
import {
  claudeDir,
  completedItems,
  completedTurnStatuses,
  completeTurn,
  dir,
  harness,
  MODEL,
  OTHER_THREAD,
  promptsUntil,
  responseTo,
  type Sent,
  SUBSCRIPTION,
  THREAD,
  turnCompleted,
  turnStart,
  until,
  useTempDir,
} from "../testing/harness.ts";

useTempDir();

describe("/resume", () => {
  test("lists the directory's conversations other threads do not continue, without starting Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, events } = await harness([claude]);
    await continuedByOtherThread(store, "se-other");
    await writeClaudeRecord(
      "se-other",
      conversationRecords("other fixture ask"),
    );
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));

    turns.startTurn(turnStart(10, "/resume"), undefined);
    await until(() => turnCompleted(sent) !== undefined);

    expect(responseTo(sent, 10)?.result.turn).toMatchObject({ id: "turn-1" });
    expect(turnCompleted(sent)).toMatchObject({ status: "completed" });
    const reply = agentTexts(sent).at(-1) ?? "";
    expect(reply).toContain("1. fixture ask");
    expect(reply).not.toContain("other fixture ask");
    expect(claude.started()).toBe(false);
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "session_command",
      command: "list",
      reply: "listed",
      error: null,
    });
    expect(JSON.stringify(events)).not.toContain("fixture ask");
  });

  test("refuses on a thread that already has a conversation and lists nothing", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));
    await completeTurn(turns, sent, claude, 10);

    turns.startTurn(turnStart(11, "/resume"), undefined);
    await until(() => completedTurnStatuses(sent).length === 2);

    const reply = agentTexts(sent).at(-1) ?? "";
    expect(reply).toContain("already has a Claude conversation");
    expect(reply).not.toContain("fixture ask");
    expect(await promptsUntil(claude, 1)).toEqual(["prompt 10"]);
  });
});

describe("a number sent after /resume", () => {
  test("continues the picked conversation from the next turn without reaching Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, settings, events } = await harness([claude]);
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));
    turns.startTurn(turnStart(10, "/resume"), undefined);
    await until(() => completedTurnStatuses(sent).length === 1);

    turns.startTurn(turnStart(11, "1"), undefined);
    await until(() => completedTurnStatuses(sent).length === 2);
    const bound = store.get(THREAD)?.sessionId;
    await completeTurn(turns, sent, claude, 12);

    expect(agentTexts(sent)[1]).toContain('continues "fixture ask"');
    expect(bound).toBe("se-a");
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "session_picked",
      thread: THREAD.slice(0, 8),
    });
    expect([turns.takePicked(THREAD), turns.takePicked(THREAD)]).toEqual([
      true,
      false,
    ]);
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ resume: "se-a" });
    expect(await promptsUntil(claude, 1)).toEqual(["prompt 12"]);
  });

  test("shows the picked conversation's earlier turns in the thread after the reply", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const replay = [{ method: "turn/started", params: { replayed: true } }];
    const asked: string[][] = [];
    const { turns, sent } = await harness([claude], {
      readHistory: async (threadId, sessionId, cwd) => {
        asked.push([threadId, sessionId, cwd]);
        return replay;
      },
    });
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));
    turns.startTurn(turnStart(10, "/resume"), undefined);
    await until(() => completedTurnStatuses(sent).length === 1);

    turns.startTurn(turnStart(11, "1"), undefined);
    await until(() => sent.includes(replay[0]));

    expect(asked).toEqual([[THREAD, "se-a", dir]]);
    expect(completedTurnStatuses(sent)).toHaveLength(2);
    const lastCompleted = sent
      .map((message: Sent) => message.method)
      .lastIndexOf("turn/completed");
    expect(sent.indexOf(replay[0])).toBeGreaterThan(lastCompleted);
    expect(turns.takePicked(THREAD)).toBe(false);
  });

  test("binds a conversation two threads pick at once to only one of them", async () => {
    const { turns, sent, store } = await harness([]);
    turns.adopt(OTHER_THREAD, { model: MODEL, cwd: dir });
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));
    turns.startTurn(turnStart(10, "/resume"), undefined);
    turns.startTurn(turnStart(11, "/resume", OTHER_THREAD), undefined);
    await until(() => completedTurnStatuses(sent).length === 2);

    turns.startTurn(turnStart(12, "1"), undefined);
    turns.startTurn(turnStart(13, "1", OTHER_THREAD), undefined);
    await until(() => completedTurnStatuses(sent).length === 4);

    const owners = [THREAD, OTHER_THREAD].filter(
      (threadId) => store.get(threadId)?.sessionId === "se-a",
    );
    expect(owners).toHaveLength(1);
    expect(
      agentTexts(sent).filter((text) =>
        text.includes("already continued in another thread"),
      ),
    ).toHaveLength(1);
  });

  test("goes to Claude when no list came before it", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns } = await harness([claude]);
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));

    turns.startTurn(turnStart(10, "1"), undefined);
    await until(() => claude.started());

    expect(await promptsUntil(claude, 1)).toEqual(["1"]);
  });

  test("goes to Claude when another turn followed the list", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store } = await harness([claude]);
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));
    turns.startTurn(turnStart(10, "/resume"), undefined);
    await until(() => completedTurnStatuses(sent).length === 1);
    await completeTurn(turns, sent, claude, 11);

    turns.startTurn(turnStart(12, "1"), undefined);

    expect(await promptsUntil(claude, 2)).toEqual(["prompt 11", "1"]);
    expect(store.get(THREAD)?.sessionId).toBe("se-1");
  });
});

describe("/session", () => {
  test("answers the directory and the quoted command to continue in a terminal, without reaching Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await completeTurn(turns, sent, claude, 10);

    turns.startTurn(turnStart(11, "/session"), undefined);
    await until(() => completedTurnStatuses(sent).length === 2);

    const reply = agentTexts(sent).at(-1) ?? "";
    expect(reply).toContain(`cd '${dir}' && claude --resume 'se-1'`);
    expect(await promptsUntil(claude, 1)).toEqual(["prompt 10"]);
  });

  test("answers that a thread has no conversation yet without starting Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "/session"), undefined);
    await until(() => turnCompleted(sent) !== undefined);

    expect(agentTexts(sent).at(-1)).toContain("no Claude conversation yet");
    expect(claude.started()).toBe(false);
  });
});

describe("a conversation continued outside its thread", () => {
  test("tells the user and resumes from the latest record on a new Claude only after the record moved on", async () => {
    const first = fakeClaude(SUBSCRIPTION);
    const second = fakeClaude(SUBSCRIPTION);
    const { turns, sent, settings, events } = await harness([first, second]);
    await writeClaudeRecord("se-1", conversationRecords("fixture ask"));
    await completeTurn(turns, sent, first, 10);
    await completeTurn(turns, sent, first, 11);
    expect(agentTexts(sent).join("\n")).not.toContain(OUTSIDE);
    await writeClaudeRecord("se-1", [
      ...conversationRecords("fixture ask"),
      { type: "assistant", uuid: "a-cli", message: { content: [] } },
    ]);

    await completeTurn(turns, sent, second, 12);

    expect(
      agentTexts(sent).filter((text) => text.includes(OUTSIDE)),
    ).toHaveLength(1);
    expect(first.closes()).toBe(1);
    expect(settings).toHaveLength(2);
    expect(settings[1]).toMatchObject({ resume: "se-1" });
    expect(completedTurnStatuses(sent)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "record_advanced",
    });
  });
});

// Claude names a project folder after its directory with every other character as a hyphen.
const writeClaudeRecord = async (sessionId: string, records: object[]) => {
  const folder = join(
    claudeDir(),
    "projects",
    dir.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, `${sessionId}.jsonl`),
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
};

const conversationRecords = (prompt: string) => [
  {
    type: "user",
    uuid: "u-1",
    cwd: dir,
    entrypoint: "cli",
    message: { role: "user", content: prompt },
  },
  { type: "assistant", uuid: "a-1", message: { content: [] } },
];

const continuedByOtherThread = async (
  store: Awaited<ReturnType<typeof harness>>["store"],
  sessionId: string,
) => {
  const registered = await store.register({
    threadId: OTHER_THREAD,
    model: MODEL,
    worktree: dir,
  });
  expect(registered.isOk()).toBe(true);
  const bound = await store.setSessionId(OTHER_THREAD, sessionId);
  expect(bound.isOk()).toBe(true);
};

const agentTexts = (sent: Sent[]): string[] =>
  completedItems(sent)
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text);

const OUTSIDE = "continued outside this thread";
