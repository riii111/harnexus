import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readExternalConversations,
  updateExternalConversations,
  writeExternalConversations,
} from "./external-conversations.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-external-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const STATE = {
  bindings: [{ adapterId: "taskctl", conversationId: "c1", threadId: "t1" }],
  intents: [
    {
      intentId: "i1",
      adapterId: "taskctl",
      conversationId: "c2",
      callerThreadId: "t0",
      createdAt: "2026-11-06T00:00:00.000Z",
    },
  ],
};

describe("readExternalConversations", () => {
  test("reads a missing file as holding nothing", async () => {
    const read = await readExternalConversations(join(dir, "none.json"));

    expect(read.unwrap()).toEqual({ bindings: [], intents: [] });
  });

  test("reads back what was written, in a folder made for it", async () => {
    const path = join(dir, "state", "external-conversations.json");

    await writeExternalConversations(path, STATE);

    expect((await readExternalConversations(path)).unwrap()).toEqual(STATE);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });

  test("refuses a file of another version rather than taking it for none", async () => {
    const path = join(dir, "external-conversations.json");
    await writeFile(path, JSON.stringify({ version: 2, ...STATE }));

    const read = await readExternalConversations(path);

    expect(read.isErr()).toBe(true);
  });
});

describe("updateExternalConversations", () => {
  test("applies changes made at once to the file as each finds it, so none is lost", async () => {
    const path = join(dir, "external-conversations.json");
    const add = (threadId: string) =>
      updateExternalConversations(path, (state) => ({
        state: {
          ...state,
          bindings: [
            ...state.bindings,
            { adapterId: "taskctl", conversationId: threadId, threadId },
          ],
        },
        result: null,
      }));

    await Promise.all([add("t1"), add("t2"), add("t3")]);

    const kept = (await readExternalConversations(path)).unwrap();
    expect(kept.bindings.map((binding) => binding.threadId).sort()).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  test("takes over a lock left by a process that is gone", async () => {
    const path = join(dir, "external-conversations.json");
    await writeFile(
      `${path}.lock`,
      JSON.stringify({ pid: 2 ** 22 + 7, at: 0 }),
    );

    const updated = await updateExternalConversations(path, (state) => ({
      state,
      result: "changed",
    }));

    expect(updated.unwrap().result).toBe("changed");
  });

  test("leaves a file it cannot read as it is", async () => {
    const path = join(dir, "external-conversations.json");
    await writeFile(path, "{");

    const updated = await updateExternalConversations(path, () => ({
      state: { bindings: [], intents: [] },
      result: null,
    }));

    expect(updated.isErr()).toBe(true);
    expect(await readFile(path, "utf8")).toBe("{");
  });
});
