import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openSideChatStore,
  type SavedSideChat,
  sideChatsPath,
  unreadableSideChats,
} from "./side-chat-store.ts";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-side-chats-"));
  path = sideChatsPath(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("openSideChatStore", () => {
  test("holds no side chat when the file does not exist", async () => {
    const store = await openStore();

    expect(store.all()).toEqual([]);
  });

  test("restores the saved side chats in a new store", async () => {
    const store = await openStore();
    await store.save(ON_CLAUDE);
    await store.save(ON_CODEX);

    const reopened = await openStore();

    expect(reopened.all()).toEqual([ON_CLAUDE, ON_CODEX]);
  });

  test("replaces a side chat saved again and removes one by its thread", async () => {
    const store = await openStore();
    await store.save(ON_CLAUDE);
    await store.save(ON_CODEX);
    await store.save({ ...ON_CLAUDE, stopped: true });
    await store.remove("th-codex");

    const reopened = await openStore();

    expect(reopened.all()).toEqual([{ ...ON_CLAUDE, stopped: true }]);
  });

  test("keeps the side chats other stores sharing the file saved", async () => {
    const first = await openStore();
    const second = await openStore();

    await first.save(ON_CLAUDE);
    await second.save(ON_CODEX);
    await first.save({ ...ON_CLAUDE, stopped: true });
    await second.remove("th-codex");
    const reopened = await openStore();
    await second.save(ON_CODEX);

    expect(reopened.all()).toEqual([{ ...ON_CLAUDE, stopped: true }]);
    expect((await openStore()).all().map(({ threadId }) => threadId)).toEqual([
      "th-claude-side",
      "th-codex",
    ]);
  });

  test.each([
    { name: "text that is no JSON", content: "not json", threadIds: [] },
    {
      name: "another version",
      content: '{"version":2,"sideChats":[{"threadId":"th-old"}]}',
      threadIds: ["th-old"],
    },
    {
      name: "a side chat with an empty model",
      content: JSON.stringify({
        version: 1,
        sideChats: [{ ...ON_CLAUDE, claude: { model: "", cwd: "/w" } }],
      }),
      threadIds: ["th-claude-side"],
    },
    {
      name: "a side chat with a field it does not know",
      content: JSON.stringify({
        version: 1,
        sideChats: [{ ...ON_CLAUDE, extra: true }],
      }),
      threadIds: ["th-claude-side"],
    },
    {
      name: "one thread twice",
      content: JSON.stringify({
        version: 1,
        sideChats: [ON_CLAUDE, ON_CLAUDE],
      }),
      threadIds: ["th-claude-side"],
    },
  ])(
    "refuses a file holding $name, names its readable threads and leaves it as it is",
    async ({ content, threadIds }) => {
      await writeFile(path, content);

      const opened = await openSideChatStore(path);

      expect(opened.isErr() && opened.error._tag).toBe(
        "SideChatStateUnreadable",
      );
      expect(opened.isErr() && opened.error.threadIds).toEqual(threadIds);
      expect(await readFile(path, "utf8")).toBe(content);
    },
  );

  test("writes only the fields it reads and no conversation text", async () => {
    const store = await openStore();
    await store.save(ON_CLAUDE);

    const written = JSON.parse(await readFile(path, "utf8"));

    expect(written).toEqual({ version: 1, sideChats: [ON_CLAUDE] });
  });

  test("reports a failed write and holds nothing from it", async () => {
    const opened = await openSideChatStore(join(dir, "missing", "file.json"));
    const store = opened.isOk() ? opened.value : expect.unreachable();

    const saved = await store.save(ON_CLAUDE);

    expect(saved.isErr() && saved.error._tag).toBe("SideChatNotSaved");
    expect(store.all()).toEqual([]);
  });

  test("saves nothing over a file that became unreadable after it was opened", async () => {
    const store = await openStore();
    await writeFile(path, "not json");

    const saved = await store.save(ON_CLAUDE);

    expect(saved.isErr() && saved.error.reason).toBe("SideChatStateUnreadable");
    expect(await readFile(path, "utf8")).toBe("not json");
  });
});

describe("unreadableSideChats", () => {
  test("names each thread as a stopped side chat and saves nothing", async () => {
    const store = unreadableSideChats(["th-a"]);

    const saved = await store.save(ON_CODEX);

    expect(store.all()).toEqual([
      {
        threadId: "th-a",
        claude: null,
        point: "unread",
        instructions: null,
        choice: null,
        stopped: true,
      },
    ]);
    expect(store.writable).toBe(false);
    expect(saved.isErr() && saved.error.reason).toBe("SideChatStateUnreadable");
  });
});

const openStore = async () => {
  const opened = await openSideChatStore(path);
  return opened.isOk() ? opened.value : expect.unreachable();
};

const ON_CLAUDE: SavedSideChat = {
  threadId: "th-claude-side",
  claude: { model: "claude-opus-5-5", cwd: "/work/tree" },
  point: {
    sessionId: "session-main",
    at: "record-9",
    model: "claude-opus-5-5",
    cwd: "/work/tree",
  },
  instructions: "You are in a side conversation.",
  choice: "claude-opus-5-5",
  stopped: false,
};

const ON_CODEX: SavedSideChat = {
  threadId: "th-codex",
  claude: null,
  point: null,
  instructions: null,
  choice: null,
  stopped: false,
};
