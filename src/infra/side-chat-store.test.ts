import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openSideChatStore,
  type SavedSideChat,
  sideChatsPath,
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

  test.each([
    { name: "text that is no JSON", content: "not json" },
    { name: "another version", content: '{"version":2,"sideChats":[]}' },
    {
      name: "a side chat with an empty thread id",
      content: JSON.stringify({
        version: 1,
        sideChats: [{ ...ON_CLAUDE, threadId: "" }],
      }),
    },
    {
      name: "a side chat with a field it does not know",
      content: JSON.stringify({
        version: 1,
        sideChats: [{ ...ON_CLAUDE, extra: true }],
      }),
    },
    {
      name: "one thread twice",
      content: JSON.stringify({
        version: 1,
        sideChats: [ON_CLAUDE, ON_CLAUDE],
      }),
    },
  ])(
    "refuses a file holding $name and leaves it as it is",
    async ({ content }) => {
      await writeFile(path, content);

      const opened = await openSideChatStore(path);

      expect(opened.isErr() && opened.error._tag).toBe(
        "SideChatStateUnreadable",
      );
      expect(await readFile(path, "utf8")).toBe(content);
    },
  );

  test("writes only the fields it reads and no conversation text", async () => {
    const store = await openStore();
    await store.save(ON_CLAUDE);

    const written = JSON.parse(await readFile(path, "utf8"));

    expect(written).toEqual({ version: 1, sideChats: [ON_CLAUDE] });
  });

  test("keeps a change in memory and reports it when its write fails", async () => {
    const opened = await openSideChatStore(join(dir, "missing", "file.json"));
    const store = opened.isOk() ? opened.value : expect.unreachable();

    const saved = await store.save(ON_CLAUDE);

    expect(saved.isErr() && saved.error._tag).toBe("SideChatNotSaved");
    expect(store.all()).toEqual([ON_CLAUDE]);
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
  stopped: false,
};

const ON_CODEX: SavedSideChat = {
  threadId: "th-codex",
  claude: null,
  point: null,
  instructions: null,
  stopped: false,
};
