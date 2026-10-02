import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listClaudeConversations, readLastRecordUuid } from "./transcripts.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-transcripts-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("listClaudeConversations", () => {
  test("lists the directory's conversations newest first with title, update time and origin", async () => {
    await writeRecord(PROJECT_FOLDER, "se-old", conversation("first ask"), {
      at: NOW - DAY,
    });
    await writeRecord(
      PROJECT_FOLDER,
      "se-new",
      [
        ...conversation("second ask", "claude-desktop"),
        { type: "ai-title", aiTitle: "Fixture title", sessionId: "se-new" },
      ],
      { at: NOW - HOUR },
    );

    const listed = await listClaudeConversations(PROJECT, {
      since: NOW - 14 * DAY,
      configDir: dir,
    });

    expect(listed.isOk() && listed.value).toEqual([
      {
        sessionId: "se-new",
        name: "Fixture title",
        title: "Fixture title",
        updatedAtMs: NOW - HOUR,
        entrypoint: "claude-desktop",
      },
      {
        sessionId: "se-old",
        name: null,
        title: "first ask",
        updatedAtMs: NOW - DAY,
        entrypoint: "cli",
      },
    ]);
  });

  test.each([
    {
      name: "an old subagent file",
      write: () =>
        writeRecord(PROJECT_FOLDER, "agent-a1", conversation("sub task")),
    },
    {
      name: "a record marked as a sidechain",
      write: () =>
        writeRecord(PROJECT_FOLDER, "se-side", [
          { ...conversation("sub task")[0], isSidechain: true },
        ]),
    },
    {
      name: "a subagent record in the conversation's folder",
      write: async () => {
        await mkdir(
          join(dir, "projects", PROJECT_FOLDER, "se-1", "subagents"),
          {
            recursive: true,
          },
        );
        await writeFile(
          join(
            dir,
            "projects",
            PROJECT_FOLDER,
            "se-1",
            "subagents",
            "agent-a1.jsonl",
          ),
          lines(conversation("sub task")),
        );
      },
    },
    {
      name: "a conversation older than the cutoff",
      write: () =>
        writeRecord(PROJECT_FOLDER, "se-stale", conversation("old ask"), {
          at: NOW - 15 * DAY,
        }),
    },
    {
      name: "a conversation in a worktree of the directory",
      write: () =>
        writeRecord(
          "-work-fixture-project--claude-worktrees-w1",
          "se-tree",
          conversation(
            "tree ask",
            "cli",
            "/work/fixture-project/.claude/worktrees/w1",
          ),
        ),
    },
    {
      name: "a directory whose folder name collides",
      write: () =>
        writeRecord(
          PROJECT_FOLDER,
          "se-collide",
          conversation("other ask", "cli", "/work/fixture/project"),
        ),
    },
    {
      name: "a conversation with no prompt",
      write: () =>
        writeRecord(PROJECT_FOLDER, "se-empty", [
          { type: "summary", cwd: PROJECT },
        ]),
    },
  ])("leaves out $name", async ({ write }) => {
    await writeRecord(PROJECT_FOLDER, "se-kept", conversation("kept ask"));
    await write();

    const listed = await listClaudeConversations(PROJECT, {
      since: NOW - 14 * DAY,
      configDir: dir,
    });

    expect(
      listed.isOk() && listed.value.map((found) => found.sessionId),
    ).toEqual(["se-kept"]);
  });

  test("titles a conversation with its first typed prompt after slash command records", async () => {
    await writeRecord(PROJECT_FOLDER, "se-1", [
      userRecord("u-0", "<command-name>/model</command-name>"),
      userRecord("u-1", [{ type: "text", text: "real\n  ask" }]),
    ]);

    const listed = await listClaudeConversations(PROJECT, {
      since: NOW - 14 * DAY,
      configDir: dir,
    });

    expect(listed.isOk() && listed.value[0]?.title).toBe("real ask");
  });

  test("lists a conversation whose first record is larger than one read", async () => {
    const long = `big ask ${"x".repeat(200 * 1024)}`;
    await writeRecord(PROJECT_FOLDER, "se-big", conversation(long));

    const listed = await listClaudeConversations(PROJECT, {
      since: NOW - 14 * DAY,
      configDir: dir,
    });

    expect(
      listed.isOk() && listed.value.map((found) => found.sessionId),
    ).toEqual(["se-big"]);
  });

  test("titles a conversation whose first prompt after a slash command is larger than one read", async () => {
    await writeRecord(PROJECT_FOLDER, "se-big", [
      userRecord("u-0", "<command-name>/model</command-name>"),
      userRecord("u-1", `big ask ${"x".repeat(200 * 1024)}`),
    ]);

    const listed = await listClaudeConversations(PROJECT, {
      since: NOW - 14 * DAY,
      configDir: dir,
    });

    expect(listed.isOk() && listed.value[0]?.title.startsWith("big ask")).toBe(
      true,
    );
  });

  test("lists nothing when Claude has no records yet", async () => {
    const listed = await listClaudeConversations(PROJECT, {
      since: NOW - 14 * DAY,
      configDir: dir,
    });

    expect(listed.isOk() && listed.value).toEqual([]);
  });
});

describe("readLastRecordUuid", () => {
  test("reads the uuid of the last conversation record, skipping records after it", async () => {
    await writeRecord(PROJECT_FOLDER, "se-1", [
      ...conversation("ask"),
      { type: "ai-title", aiTitle: "Title", sessionId: "se-1" },
    ]);

    const last = await readLastRecordUuid("se-1", dir);

    expect(last.isOk() && last.value).toBe("a-1");
  });

  test("reads past a last record larger than one read", async () => {
    await writeRecord(PROJECT_FOLDER, "se-1", [
      ...conversation("ask"),
      { ...assistantRecord("a-2"), padding: "x".repeat(200 * 1024) },
    ]);

    const last = await readLastRecordUuid("se-1", dir);

    expect(last.isOk() && last.value).toBe("a-2");
  });

  test("reads null for a conversation Claude has no record of", async () => {
    const last = await readLastRecordUuid("se-missing", dir);

    expect(last.isOk() && last.value).toBeNull();
  });
});

const writeRecord = async (
  folder: string,
  sessionId: string,
  records: object[],
  { at = NOW - HOUR }: { at?: number } = {},
) => {
  const path = join(dir, "projects", folder, `${sessionId}.jsonl`);
  await mkdir(join(dir, "projects", folder), { recursive: true });
  await writeFile(path, lines(records));
  await utimes(path, at / 1000, at / 1000);
};

const lines = (records: object[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");

const conversation = (prompt: string, entrypoint = "cli", cwd = PROJECT) => [
  { ...userRecord("u-1", prompt), entrypoint, cwd },
  assistantRecord("a-1"),
];

const userRecord = (uuid: string, content: unknown) => ({
  type: "user",
  uuid,
  cwd: PROJECT,
  isSidechain: false,
  message: { role: "user", content },
});

const assistantRecord = (uuid: string) => ({
  type: "assistant",
  uuid,
  cwd: PROJECT,
  isSidechain: false,
  message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
});

const PROJECT = "/work/fixture-project";
const PROJECT_FOLDER = "-work-fixture-project";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
