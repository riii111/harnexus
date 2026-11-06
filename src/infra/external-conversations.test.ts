import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileExclusive } from "../lib/fs.boundary.ts";
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
  bindings: [{ adapterId: "my-adapter", conversationId: "c1", threadId: "t1" }],
  intents: [
    {
      intentId: "i1",
      adapterId: "my-adapter",
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
        { adapterId: "my-adapter", conversationId: threadId, threadId },
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

  test("makes a change worked out on a revision since emptied again on the latest, never over the emptied number", async () => {
    const folder = join(dir, "external-conversations");
    await bind(folder, "t0");
    const seen: number[] = [];

    const stale = await updateExternalConversations(folder, (state) => {
      seen.push(state.bindings.length);
      // While this change is worked out from revision 1, other bridges make revisions up to 12, emptying the oldest.
      if (seen.length === 1)
        for (const revision of Array.from({ length: 11 }, (_, at) => at + 2))
          writeFileSync(
            join(folder, `${String(revision).padStart(12, "0")}.json`),
            revision <= 4
              ? ""
              : JSON.stringify({
                  version: 1,
                  bindings: Array.from({ length: revision }, (_, at) => ({
                    adapterId: "my-adapter",
                    conversationId: `t${at}`,
                    threadId: `t${at}`,
                  })),
                  intents: [],
                }),
          );
      return {
        state: { ...state, intents: [...STATE.intents] },
        result: null,
      };
    });

    const kept = (await readExternalConversations(folder)).unwrap();
    expect(stale.isOk()).toBe(true);
    expect(seen).toEqual([1, 12]);
    expect(kept.revision).toBe(13);
    expect(kept.state.intents).toHaveLength(1);
    expect(await readFile(join(folder, "000000000002.json"), "utf8")).toBe("");
  });

  test("never makes a revision whose number an emptied one holds", async () => {
    const folder = join(dir, "external-conversations");
    for (const threadId of Array.from({ length: 12 }, (_, at) => `t${at}`))
      await bind(folder, threadId);

    const again = await writeFileExclusiveAt(join(folder, "000000000002.json"));

    expect(again).toBe(false);
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

const writeFileExclusiveAt = async (path: string) =>
  (await writeFileExclusive(path, "{}")).unwrap();
