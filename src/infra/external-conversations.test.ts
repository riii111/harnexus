import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readExternalConversations,
  updateExternalConversations,
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

const bind = (folder: string, threadId: string) =>
  updateExternalConversations(folder, (state) => ({
    state: {
      ...state,
      bindings: [
        ...state.bindings,
        { adapterId: "taskctl", conversationId: threadId, threadId },
      ],
    },
    result: threadId,
  }));

describe("readExternalConversations", () => {
  test("reads a missing folder as holding nothing", async () => {
    const read = await readExternalConversations(join(dir, "none"));

    expect(read.unwrap()).toEqual({
      revision: 0,
      state: { bindings: [], intents: [] },
    });
  });

  test("refuses a latest revision of another version rather than taking it for none", async () => {
    const folder = join(dir, "external-conversations");
    await mkdir(folder);
    await writeFile(
      join(folder, "000000000001.json"),
      JSON.stringify({ version: 2, ...STATE }),
    );

    const read = await readExternalConversations(folder);

    expect(read.isErr()).toBe(true);
  });
});

describe("updateExternalConversations", () => {
  test("reads back what was changed, in a folder made for it", async () => {
    const folder = join(dir, "state", "external-conversations");

    await updateExternalConversations(folder, () => ({
      state: STATE,
      result: null,
    }));

    expect((await readExternalConversations(folder)).unwrap()).toEqual({
      revision: 1,
      state: STATE,
    });
  });

  test("makes each of changes made at once on the revision before it, so none is lost", async () => {
    const folder = join(dir, "external-conversations");

    await Promise.all([
      bind(folder, "t1"),
      bind(folder, "t2"),
      bind(folder, "t3"),
    ]);

    const kept = (await readExternalConversations(folder)).unwrap();
    expect(
      kept.state.bindings.map((binding) => binding.threadId).sort(),
    ).toEqual(["t1", "t2", "t3"]);
    expect(kept.revision).toBe(3);
  });

  test("makes a change worked out on an older revision again on the newer one instead of writing over it", async () => {
    const folder = join(dir, "external-conversations");
    await bind(folder, "t1");
    const seen: number[] = [];

    const late = await updateExternalConversations(folder, (state) => {
      seen.push(state.bindings.length);
      // Another bridge makes the next revision while this change is worked out.
      if (seen.length === 1)
        writeFileSync(
          join(folder, "000000000002.json"),
          JSON.stringify({
            version: 1,
            bindings: [...state.bindings, ...STATE.bindings],
            intents: [],
          }),
        );
      return {
        state: { ...state, intents: [...STATE.intents] },
        result: null,
      };
    });

    const kept = (await readExternalConversations(folder)).unwrap();
    expect(late.isOk()).toBe(true);
    expect(seen).toEqual([1, 2]);
    expect(kept).toMatchObject({ revision: 3 });
    expect(kept.state.bindings).toHaveLength(2);
    expect(kept.state.intents).toHaveLength(1);
  });

  test("keeps only the latest revisions", async () => {
    const folder = join(dir, "external-conversations");
    for (const threadId of Array.from({ length: 12 }, (_, at) => `t${at}`))
      await bind(folder, threadId);

    const names = await readdir(folder);

    expect(names.sort()[0]).toBe("000000000005.json");
    expect(names).toHaveLength(8);
  });

  test("leaves a revision it cannot read as it is", async () => {
    const folder = join(dir, "external-conversations");
    await mkdir(folder);
    await writeFile(join(folder, "000000000001.json"), "{");

    const updated = await bind(folder, "t1");

    expect(updated.isErr()).toBe(true);
    expect(await readdir(folder)).toEqual(["000000000001.json"]);
  });
});
