import { describe, expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "better-result";
import {
  type Connection,
  SUBSCRIPTION_CONNECTION,
} from "../../infra/claude/connection.ts";
import { fakeClaude } from "../../infra/claude/testing/fake-claude.ts";
import { writeFileAtomic } from "../../runtime/fs.boundary.ts";
import {
  claudeDir,
  completedItems,
  completedTurnStatuses,
  completeTurn,
  dir,
  diskFull,
  harness,
  interrupt,
  MODEL,
  OTHER_THREAD,
  promptsUntil,
  resolvedRequests,
  responseTo,
  type Sent,
  SUBSCRIPTION,
  THREAD,
  turnCompleted,
  turnStart,
  until,
  useTempDir,
  VERTEX,
  VERTEX_ACCOUNT,
  VERTEX_MODEL,
} from "../testing/harness.ts";

useTempDir();

describe("/resume", () => {
  test("asks which of the directory's conversations to continue, marking those other threads continue, without starting Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store } = await harness([claude]);
    await continuedByOtherThread(store, "se-other");
    await writeClaudeRecord(
      "se-other",
      conversationRecords("other fixture ask"),
      2,
    );
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"), 1);

    turns.startTurn(turnStart(10, "/resume"), undefined);
    const question = await pickQuestion(sent, 1);

    expect(responseTo(sent, 10)?.result.turn).toMatchObject({ id: "turn-1" });
    expect(question.method).toBe("item/tool/requestUserInput");
    expect(question.params.questions[0]).toMatchObject({
      isOther: true,
      options: [
        { label: "fixture ask", description: expect.stringMatching(/ · CLI$/) },
        {
          label: "other fixture ask",
          description: expect.stringMatching(/ · continued in another thread$/),
        },
      ],
    });
    expect(claude.started()).toBe(false);
    expect(turnCompleted(sent)).toBeUndefined();
  });

  test("continues the picked conversation from the next turn without reaching Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent, store, settings, events } = await harness([claude]);
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));
    turns.startTurn(turnStart(10, "/resume"), undefined);
    const question = await pickQuestion(sent, 1);

    answerPick(turns, question, "fixture ask");
    await until(() => completedTurnStatuses(sent).length === 1);
    const bound = store.get(THREAD)?.sessionId;
    await completeTurn(turns, sent, claude, 11);

    expect(agentTexts(sent)[0]).toContain('continues "fixture ask"');
    expect(bound).toBe("se-a");
    expect(resolvedRequests(sent)).toEqual([question.id]);
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "session_command",
      command: "resume",
      reply: "selected",
      error: null,
    });
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "session_picked",
      thread: THREAD.slice(0, 8),
    });
    expect(JSON.stringify(events)).not.toContain("fixture ask");
    expect([turns.takePicked(THREAD), turns.takePicked(THREAD)]).toEqual([
      true,
      false,
    ]);
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ resume: "se-a" });
    expect(await promptsUntil(claude, 1)).toEqual(["prompt 11"]);
  });

  test("lists older conversations a page at a time and continues one picked from a later page", async () => {
    const { turns, sent, store } = await harness([]);
    for (let n = 1; n <= 10; n += 1) {
      await writeClaudeRecord(`se-${n}`, conversationRecords(`ask ${n}`), n);
    }
    turns.startTurn(turnStart(10, "/resume"), undefined);
    const first = await pickQuestion(sent, 1);

    answerPick(turns, first, "Older conversations");
    const second = await pickQuestion(sent, 2);
    answerPick(turns, second, "ask 10");
    await until(() => completedTurnStatuses(sent).length === 1);

    expect(optionLabels(first)).toEqual([
      ...["ask 1", "ask 2", "ask 3", "ask 4", "ask 5", "ask 6", "ask 7"],
      "ask 8",
      "Older conversations",
    ]);
    expect(optionLabels(second)).toEqual(["ask 9", "ask 10"]);
    expect(questionText(second)).toContain("Showing 9–10 of 10.");
    expect(store.get(THREAD)?.sessionId).toBe("se-10");
  });

  test.each<{ name: string; command: string; typed: string | null }>([
    { name: "typed in the question", command: "/resume", typed: "LOGIN fix" },
    { name: "sent with /resume", command: "/resume login  fix", typed: null },
  ])("narrows the list to the conversations whose title holds every word $name", async ({
    command,
    typed,
  }) => {
    const { turns, sent } = await harness([]);
    await writeLoginRecords();
    turns.startTurn(turnStart(10, command), undefined);

    const asked = await askedAfter(turns, sent, typed);

    expect(optionLabels(asked)).toEqual(["fix the login bug"]);
    expect(questionText(asked)).toMatch(/Only those matching ".+" are listed/);
  });

  test("narrows the list to the conversation with a typed session id", async () => {
    const { turns, sent } = await harness([]);
    await writeLoginRecords();
    turns.startTurn(turnStart(10, "/resume"), undefined);

    const asked = await askedAfter(turns, sent, "se-b");

    expect(optionLabels(asked)).toEqual(["add the login page"]);
  });

  test("lists every conversation again when nothing matches the typed words", async () => {
    const { turns, sent } = await harness([]);
    await writeLoginRecords();
    turns.startTurn(turnStart(10, "/resume"), undefined);

    const asked = await askedAfter(turns, sent, "nothing like it");

    expect(optionLabels(asked)).toHaveLength(3);
    expect(questionText(asked)).toContain(
      'No conversation matches "nothing like it", so all are listed.',
    );
  });

  test("ends the turn continuing nothing when the question closes without an answer", async () => {
    const { turns, sent, store, events } = await harness([]);
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));
    turns.startTurn(turnStart(10, "/resume"), undefined);
    const question = await pickQuestion(sent, 1);

    turns.answerRequest({ id: question.id, result: { answers: {} } });
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "completed" });
    expect(agentTexts(sent).at(-1)).toContain("No conversation was picked");
    expect(store.get(THREAD)?.sessionId ?? null).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({ command: "resume", reply: "notPicked" }),
    );
  });

  test("closes the question and ends the turn interrupted when the user stops it", async () => {
    const { turns, sent, store } = await harness([]);
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));
    turns.startTurn(turnStart(10, "/resume"), undefined);
    const question = await pickQuestion(sent, 1);

    turns.interruptTurn(interrupt(20, "turn-1"));
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
    expect(resolvedRequests(sent)).toEqual([question.id]);
    expect(store.get(THREAD)?.sessionId ?? null).toBeNull();
  });

  test("asks nothing and ends the turn interrupted when the user stops it while the list is read", async () => {
    let listing = false;
    let read = () => {};
    const listed = new Promise<void>((resolve) => {
      read = resolve;
    });
    const { turns, sent, store } = await harness([], {
      beforeList: () => {
        listing = true;
        return listed;
      },
    });
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));
    turns.startTurn(turnStart(10, "/resume"), undefined);
    await until(() => listing);

    turns.interruptTurn(interrupt(20, "turn-1"));
    read();
    await until(() => turnCompleted(sent) !== undefined);

    expect(turnCompleted(sent)).toMatchObject({ status: "interrupted" });
    expect(pickQuestions(sent)).toEqual([]);
    expect(store.get(THREAD)?.sessionId ?? null).toBeNull();
  });

  test("answers that there is nothing to continue without asking", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);

    turns.startTurn(turnStart(10, "/resume"), undefined);
    await until(() => turnCompleted(sent) !== undefined);

    expect(agentTexts(sent).at(-1)).toContain(
      "No Claude Code conversation from the last 14 days",
    );
    expect(pickQuestions(sent)).toEqual([]);
    expect(claude.started()).toBe(false);
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
    expect(pickQuestions(sent)).toEqual([]);
    expect(await promptsUntil(claude, 1)).toEqual(["prompt 10"]);
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

    answerPick(turns, await pickQuestion(sent, 1), "fixture ask");
    await until(() => sent.includes(replay[0]));

    expect(asked).toEqual([[THREAD, "se-a", dir]]);
    expect(completedTurnStatuses(sent)).toHaveLength(1);
    const lastCompleted = sent
      .map((message: Sent) => message.method)
      .lastIndexOf("turn/completed");
    expect(sent.indexOf(replay[0])).toBeGreaterThan(lastCompleted);
    expect(turns.takePicked(THREAD)).toBe(false);
  });

  test.each<{ name: string; records: () => object[] }>([
    {
      name: "the name Claude gave",
      records: () => [
        ...conversationRecords("fixture ask"),
        { type: "ai-title", aiTitle: "Fixture title", sessionId: "se-a" },
      ],
    },
    {
      name: "the name the user gave",
      records: () => [
        ...conversationRecords("fixture ask"),
        { type: "ai-title", aiTitle: "Other title", sessionId: "se-a" },
        {
          type: "custom-title",
          customTitle: "Fixture title",
          sessionId: "se-a",
        },
      ],
    },
  ])("renames the thread to $name of the picked conversation", async ({
    records,
  }) => {
    const { turns, sent, renames } = await harness([]);
    await writeClaudeRecord("se-a", records());
    turns.startTurn(turnStart(10, "/resume"), undefined);

    answerPick(turns, await pickQuestion(sent, 1), "Fixture title");
    await until(() => renames.length === 1);

    expect(renames).toEqual([{ threadId: THREAD, name: "Fixture title" }]);
  });

  test("leaves the thread's name as it was for a conversation with no name", async () => {
    const { turns, sent, store, renames } = await harness([]);
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));
    turns.startTurn(turnStart(10, "/resume"), undefined);

    answerPick(turns, await pickQuestion(sent, 1), "fixture ask");
    await until(() => completedTurnStatuses(sent).length === 1);

    expect(store.get(THREAD)?.sessionId).toBe("se-a");
    expect(renames).toEqual([]);
  });

  test("keeps the pick when the rename fails and logs only the error tag", async () => {
    const replay = [{ method: "turn/started", params: { replayed: true } }];
    const { turns, sent, store, events, renames } = await harness([], {
      renameFails: true,
      readHistory: async () => replay,
    });
    await writeClaudeRecord("se-a", [
      ...conversationRecords("fixture ask"),
      { type: "ai-title", aiTitle: "Fixture title", sessionId: "se-a" },
    ]);
    turns.startTurn(turnStart(10, "/resume"), undefined);

    answerPick(turns, await pickQuestion(sent, 1), "Fixture title");
    await until(() => sent.includes(replay[0]));
    await until(() => events.some((e) => e.step === "thread_not_renamed"));

    expect(renames).toHaveLength(1);
    expect(store.get(THREAD)?.sessionId).toBe("se-a");
    expect(events).toContainEqual({
      event: "claude_turn",
      step: "thread_not_renamed",
      error: "ServerRequestRejected",
    });
    expect(JSON.stringify(events)).not.toContain("Fixture title");
  });

  test("refuses a listed conversation another thread continues", async () => {
    const { turns, sent, store } = await harness([]);
    await continuedByOtherThread(store, "se-other");
    await writeClaudeRecord("se-other", conversationRecords("other ask"));
    turns.startTurn(turnStart(10, "/resume"), undefined);

    answerPick(turns, await pickQuestion(sent, 1), "other ask");
    await until(() => completedTurnStatuses(sent).length === 1);

    expect(agentTexts(sent).at(-1)).toContain(
      "already continued in another thread",
    );
    expect(store.get(THREAD)?.sessionId ?? null).toBeNull();
  });

  test("binds a conversation two threads pick at once to only one of them", async () => {
    const { turns, sent, store } = await harness([]);
    turns.adopt(OTHER_THREAD, { model: MODEL, cwd: dir });
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));
    turns.startTurn(turnStart(10, "/resume"), undefined);
    turns.startTurn(turnStart(11, "/resume", OTHER_THREAD), undefined);
    await until(() => pickQuestions(sent).length === 2);

    for (const question of pickQuestions(sent)) {
      answerPick(turns, question, "fixture ask");
    }
    await until(() => completedTurnStatuses(sent).length === 2);

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

  test("leaves a number sent after it to Claude", async () => {
    const claude = fakeClaude(SUBSCRIPTION);
    const { turns, sent } = await harness([claude]);
    await writeClaudeRecord("se-a", conversationRecords("fixture ask"));
    turns.startTurn(turnStart(10, "/resume"), undefined);
    const question = await pickQuestion(sent, 1);
    turns.answerRequest({ id: question.id, result: { answers: {} } });
    await until(() => completedTurnStatuses(sent).length === 1);

    turns.startTurn(turnStart(11, "1"), undefined);
    await until(() => claude.started());

    expect(await promptsUntil(claude, 1)).toEqual(["1"]);
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
    expect(reply).not.toContain("Claude Code settings");
    expect(await promptsUntil(claude, 1)).toEqual(["prompt 10"]);
  });

  test("answers a Vertex chat's provider, project and region with a terminal command that stays on them", async () => {
    const claude = fakeClaude(VERTEX_ACCOUNT);
    const { turns, sent } = await harness([claude], {
      resolveConnection: async () => Result.ok(VERTEX),
      model: VERTEX_MODEL,
    });
    await completeTurn(turns, sent, claude, 10);

    turns.startTurn(turnStart(11, "/session"), undefined);
    await until(() => completedTurnStatuses(sent).length === 2);

    const reply = agentTexts(sent).at(-1) ?? "";
    expect(reply).toContain(
      "- Provider: Google Vertex AI (confirmed by Claude Code when this chat's Claude session started)",
    );
    expect(reply).toContain(
      "- Google Cloud project: `sidework-project` (from this repository's Claude Code settings)",
    );
    expect(reply).toContain(
      `cd '${dir}' && CLAUDE_CODE_USE_VERTEX='1' ANTHROPIC_VERTEX_PROJECT_ID='sidework-project' CLOUD_ML_REGION='global' claude --resume 'se-1'`,
    );
  });

  test("answers a terminal command with the repository's model settings and asks for its credentials file without showing its path", async () => {
    const pinned = {
      ...VERTEX,
      env: {
        ...VERTEX.env,
        GOOGLE_APPLICATION_CREDENTIALS: "/keys/sidework.json",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5@20251001",
      },
    };
    const claude = fakeClaude(VERTEX_ACCOUNT);
    const { turns, sent } = await harness([claude], {
      resolveConnection: async () => Result.ok(pinned),
      model: VERTEX_MODEL,
    });
    await completeTurn(turns, sent, claude, 10);

    turns.startTurn(turnStart(11, "/session"), undefined);
    await until(() => completedTurnStatuses(sent).length === 2);

    const reply = agentTexts(sent).at(-1) ?? "";
    expect(reply).toContain(
      "CLOUD_ML_REGION='global' ANTHROPIC_DEFAULT_HAIKU_MODEL='claude-haiku-4-5@20251001' claude --resume 'se-1'",
    );
    expect(reply).toContain("Also set GOOGLE_APPLICATION_CREDENTIALS");
    expect(reply).not.toContain("/keys/sidework.json");
  });

  test("answers the Vertex connection a new thread will confirm without starting Claude", async () => {
    const claude = fakeClaude(VERTEX_ACCOUNT);
    const { turns, sent } = await harness([claude], {
      resolveConnection: async () => Result.ok(VERTEX),
      model: VERTEX_MODEL,
    });

    turns.startTurn(turnStart(10, "/session"), undefined);
    await until(() => turnCompleted(sent) !== undefined);

    const reply = agentTexts(sent).at(-1) ?? "";
    expect(reply).toContain("no Claude conversation yet");
    expect(reply).toContain(
      "This repository's Claude Code settings choose Google Vertex AI (project `sidework-project`, region `global`)",
    );
    expect(claude.started()).toBe(false);
  });

  test("answers that the repository's settings changed and how to move the chat", async () => {
    let current: Connection = VERTEX;
    const claude = fakeClaude(VERTEX_ACCOUNT);
    const { turns, sent } = await harness([claude], {
      resolveConnection: async () => Result.ok(current),
      model: VERTEX_MODEL,
    });
    await completeTurn(turns, sent, claude, 10);
    current = SUBSCRIPTION_CONNECTION;

    turns.startTurn(turnStart(11, "/session"), undefined);
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(agentTexts(sent).at(-1)).toContain(
      "This repository's Claude Code settings now choose your Claude subscription. Send /switch-connection",
    );
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

describe("/switch-connection", () => {
  test("moves a chat to the repository's new connection, which the next turn confirms and shows", async () => {
    let current: Connection = VERTEX;
    const first = fakeClaude(VERTEX_ACCOUNT);
    const second = fakeClaude(VERTEX_ACCOUNT);
    const { turns, sent, settings, store } = await harness([first, second], {
      resolveConnection: async () => Result.ok(current),
      model: VERTEX_MODEL,
    });
    await completeTurn(turns, sent, first, 10);
    current = {
      ...VERTEX,
      projectId: "next-project",
      env: { ...VERTEX.env, ANTHROPIC_VERTEX_PROJECT_ID: "next-project" },
    };

    turns.startTurn(turnStart(11, "/switch-connection"), undefined);
    await until(() => completedTurnStatuses(sent).length === 2);
    const switched = agentTexts(sent).at(-1);
    await completeTurn(turns, sent, second, 12);

    expect(switched).toContain(
      "now follows this repository's Claude Code settings",
    );
    expect(first.closes()).toBe(1);
    expect(settings[1]).toMatchObject({
      resume: "se-1",
      connection: { projectId: "next-project" },
    });
    expect(agentTexts(sent).at(-2)).toContain(
      "- Google Cloud project: `next-project` (from this repository's Claude Code settings)",
    );
    expect(store.get(THREAD)?.connection).toEqual({
      provider: "vertex",
      projectId: "next-project",
      region: "global",
    });
  });

  test("keeps the chat's connection when the change cannot be saved", async () => {
    let current: Connection = VERTEX;
    const claude = fakeClaude(VERTEX_ACCOUNT);
    let refuse = false;
    const { turns, sent, store } = await harness([claude], {
      resolveConnection: async () => Result.ok(current),
      model: VERTEX_MODEL,
      files: {
        writeState: async (target, content) =>
          refuse ? diskFull(target) : writeFileAtomic(target, content),
      },
    });
    await completeTurn(turns, sent, claude, 10);
    await until(() => store.get(THREAD)?.runState === "idle");
    current = SUBSCRIPTION_CONNECTION;
    refuse = true;

    turns.startTurn(turnStart(11, "/switch-connection"), undefined);
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(agentTexts(sent).at(-1)).toContain("could not save the change");
    expect(store.get(THREAD)?.connection).toMatchObject({
      provider: "vertex",
    });
  });

  test("changes nothing when the chat already runs on the repository's connection", async () => {
    const claude = fakeClaude(VERTEX_ACCOUNT);
    const { turns, sent, store } = await harness([claude], {
      resolveConnection: async () => Result.ok(VERTEX),
      model: VERTEX_MODEL,
    });
    await completeTurn(turns, sent, claude, 10);

    turns.startTurn(turnStart(11, "/switch-connection"), undefined);
    await until(() => completedTurnStatuses(sent).length === 2);

    expect(agentTexts(sent).at(-1)).toContain("nothing changed");
    expect(claude.closes()).toBe(0);
    expect(store.get(THREAD)?.connection).toMatchObject({
      projectId: "sidework-project",
    });
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

// Claude names a project folder after its directory with every other character as a hyphen; the list puts the record changed last first.
const writeClaudeRecord = async (
  sessionId: string,
  records: object[],
  minutesAgo = 0,
) => {
  const folder = join(
    claudeDir(),
    "projects",
    dir.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  await mkdir(folder, { recursive: true });
  const file = join(folder, `${sessionId}.jsonl`);
  await writeFile(
    file,
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  const changed = new Date(Date.now() - minutesAgo * 60_000);
  await utimes(file, changed, changed);
};

const writeLoginRecords = async () => {
  await writeClaudeRecord("se-a", conversationRecords("fix the login bug"), 1);
  await writeClaudeRecord("se-b", conversationRecords("add the login page"), 2);
  await writeClaudeRecord("se-c", conversationRecords("fix a flaky test"), 3);
};

const pickQuestions = (sent: Sent[]) =>
  sent.filter(
    (message) =>
      typeof message.id === "string" &&
      message.method === "item/tool/requestUserInput",
  );

const pickQuestion = async (sent: Sent[], count: number) => {
  await until(() => pickQuestions(sent).length >= count);
  return pickQuestions(sent)[count - 1];
};

const answerPick = (
  turns: Awaited<ReturnType<typeof harness>>["turns"],
  question: Sent,
  typed: string,
) =>
  turns.answerRequest({
    id: question.id,
    result: {
      answers: { [question.params.questions[0].id]: { answers: [typed] } },
    },
  });

// Typing nothing keeps the first question, as /resume with words narrows it already.
const askedAfter = async (
  turns: Awaited<ReturnType<typeof harness>>["turns"],
  sent: Sent[],
  typed: string | null,
) => {
  const first = await pickQuestion(sent, 1);
  if (typed === null) return first;
  answerPick(turns, first, typed);
  return pickQuestion(sent, 2);
};

const optionLabels = (question: Sent): string[] =>
  question.params.questions[0].options.map(
    (option: { label: string }) => option.label,
  );

const questionText = (question: Sent): string =>
  question.params.questions[0].question;

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
