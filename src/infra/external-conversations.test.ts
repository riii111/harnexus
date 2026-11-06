import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readExternalConversations,
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
