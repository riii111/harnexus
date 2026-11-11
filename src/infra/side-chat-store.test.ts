import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openSideChatStore,
  type SavedSideChat,
  sideChatsPath,
  unreadableSideChats,
} from "./side-chat-store.ts";

let dir: string;
let folder: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-side-chats-"));
  folder = sideChatsPath(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("openSideChatStore", () => {
  test("holds no side chat when nothing was saved", async () => {
    const store = await openStore();

    expect(store.all()).toEqual([]);
    expect(store.usable).toBe(true);
  });

  test("restores the saved side chats in a new store", async () => {
    const store = await openStore();
    await store.save(ON_CLAUDE);
    await store.save(ON_CODEX);

    const reopened = await openStore();

    expect(sorted(reopened.all())).toEqual(sorted([ON_CLAUDE, ON_CODEX]));
  });

  test("replaces a side chat saved again and removes one by its thread", async () => {
    const store = await openStore();
    await store.save(ON_CLAUDE);
    await store.save(ON_CODEX);
    await store.save({ ...ON_CLAUDE, stopped: true });
    await store.remove("th-codex");

    const reopened = await openStore();

    expect(reopened.all()).toEqual([{ ...ON_CLAUDE, stopped: true }]);
    expect(await readdir(folder)).toHaveLength(1);
  });

  test("keeps the side chats other stores sharing the folder saved", async () => {
    const first = await openStore();
    const second = await openStore();

    await first.save(ON_CLAUDE);
    await second.save(ON_CODEX);
    await first.save({ ...ON_CLAUDE, stopped: true });
    await second.remove("th-codex");
    await second.save(ON_CODEX);

    expect(
      (await openStore())
        .all()
        .map(({ threadId }) => threadId)
        .sort(),
    ).toEqual(["th-claude-side", "th-codex"]);
  });

  test("writes only the fields it reads and no conversation text", async () => {
    const store = await openStore();
    await store.save(ON_CLAUDE);

    const [name] = await readdir(folder);
    const written = JSON.parse(
      await readFile(join(folder, name ?? ""), "utf8"),
    );

    expect(written).toEqual(ON_CLAUDE);
  });

  test.each([
    { name: "text that is no JSON", content: "not json" },
    { name: "an empty file", content: "" },
    {
      name: "a side chat with a field it does not know",
      content: JSON.stringify({ ...ON_CLAUDE, extra: true }),
    },
    {
      name: "a side chat of another thread",
      content: JSON.stringify({ ...ON_CLAUDE, threadId: "th-other" }),
    },
  ])(
    "lists a file holding $name as a stopped side chat of its thread and leaves it as it is",
    async ({ content }) => {
      const store = await openStore();
      await store.save(ON_CLAUDE);
      await store.save(ON_CODEX);
      const file = join(folder, await fileNameOf("th-claude-side"));
      await writeFile(file, content);

      const reopened = await openStore();

      expect(sorted(reopened.all())).toEqual(
        sorted([
          {
            threadId: "th-claude-side",
            claude: null,
            point: "unread",
            instructions: null,
            choice: null,
            stopped: true,
          },
          ON_CODEX,
        ]),
      );
      expect(await readFile(file, "utf8")).toBe(content);
    },
  );

  test("ignores files that are no side chat's", async () => {
    const store = await openStore();
    await store.save(ON_CODEX);
    await writeFile(join(folder, ".leftover.tmp"), "x");
    await writeFile(join(folder, "notes.json"), "x");

    const reopened = await openStore();

    expect(reopened.all()).toEqual([ON_CODEX]);
  });

  test("reports a failed write and holds nothing from it", async () => {
    const store = await openStore();
    await rm(folder, { recursive: true });
    await writeFile(folder, "a file where the folder was");

    const saved = await store.save(ON_CLAUDE);

    expect(saved.isErr() && saved.error._tag).toBe("SideChatNotSaved");
    expect(store.all()).toEqual([]);
  });

  test("refuses a folder that cannot be listed", async () => {
    await writeFile(folder, "a file where the folder should be");

    const opened = await openSideChatStore(folder);

    expect(opened.isErr() && opened.error._tag).toBe("SideChatStateUnreadable");
  });
});

describe("unreadableSideChats", () => {
  test("holds no side chat, is unusable and saves nothing", async () => {
    const store = unreadableSideChats();

    const saved = await store.save(ON_CODEX);

    expect(store.all()).toEqual([]);
    expect(store.usable).toBe(false);
    expect(saved.isErr() && saved.error.reason).toBe("SideChatStateUnreadable");
  });
});

const openStore = async () => {
  const opened = await openSideChatStore(folder);
  return opened.isOk() ? opened.value : expect.unreachable();
};

const fileNameOf = async (threadId: string) => {
  const name = `${Buffer.from(threadId, "utf8").toString("hex")}.json`;
  return (await readdir(folder)).includes(name)
    ? name
    : expect.unreachable("not saved");
};

const sorted = (records: readonly SavedSideChat[]) =>
  [...records].sort((a, b) => a.threadId.localeCompare(b.threadId));

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
