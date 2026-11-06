import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enterAsBridge } from "../infra/state-locks.ts";
import { runHarnexus } from "./harnexus-command.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-state-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const state = (args: readonly string[], stdin = "") =>
  runHarnexus(["state", ...args], {
    // No call socket is named, so an operation that tried to reach a bridge would fail.
    env: {
      HARNEXUS_STATE_PATH: join(dir, "threads.json"),
      HARNEXUS_CALL_SOCKET: join(dir, "missing.sock"),
    },
    cwd: dir,
    readStdin: async () => stdin,
  });

const exchange = (...links: [string, string | null][]) =>
  JSON.stringify({
    version: 1,
    links: links.map(([sessionId, threadId]) => ({
      sessionId,
      threadId,
      reservedAt: "2026-11-01T00:00:00Z",
    })),
  });

describe("harnexus state", () => {
  test("imports reservations from a file and exports them in the same format", async () => {
    const file = join(dir, "links.json");
    await writeFile(
      file,
      exchange(["session_01A", "chat-a"], ["session_01B", null]),
    );

    const imported = await state(["import-cloud-links", "--file", file]);
    const exported = await state(["export-cloud-links"]);

    expect(imported.code).toBe(0);
    expect(JSON.parse(imported.stdout).result).toMatchObject({ imported: 2 });
    expect(JSON.parse(exported.stdout)).toEqual(
      JSON.parse(await readFile(file, "utf8")),
    );
  });

  test("takes nothing in twice when the same reservations are imported again from stdin", async () => {
    await state(["import-cloud-links"], exchange(["session_01A", "chat-a"]));
    const before = await readFile(join(dir, "cloud-links.json"), "utf8");

    const again = await state(
      ["import-cloud-links"],
      exchange(["session_01A", "chat-a"]),
    );

    expect(JSON.parse(again.stdout).result).toEqual({
      imported: 0,
      present: 1,
      conflicts: [],
      alreadyImported: true,
    });
    expect(await readFile(join(dir, "cloud-links.json"), "utf8")).toBe(before);
  });

  test("refuses an import that names another chat for a reserved session, leaving the file as it was", async () => {
    await state(["import-cloud-links"], exchange(["session_01A", "chat-a"]));
    const before = await readFile(join(dir, "cloud-links.json"), "utf8");

    const refused = await state(
      ["import-cloud-links"],
      exchange(["session_01A", "chat-b"]),
    );

    expect(refused.code).toBe(4);
    expect(JSON.parse(refused.stdout).result.conflicts).toEqual([
      { sessionId: "session_01A", kept: "chat-a", offered: "chat-b" },
    ]);
    expect(await readFile(join(dir, "cloud-links.json"), "utf8")).toBe(before);
  });

  test.each([
    { name: "export", args: ["export-cloud-links"] },
    { name: "import", args: ["import-cloud-links"] },
  ])(
    "refuses to $name while a bridge runs, writing nothing",
    async ({ args }) => {
      const bridge = (await enterAsBridge(dir)).unwrap();

      const refused = await state(args, exchange(["session_01A", "chat-a"]));

      expect(refused.code).toBe(4);
      expect(refused.stderr).toContain(String(process.pid));
      expect(
        await readFile(join(dir, "cloud-links.json"), "utf8").catch(() => null),
      ).toBeNull();
      await rm(bridge.presence);
    },
  );

  test("never lets a bridge start and an import go on at once", async () => {
    for (let round = 0; round < 20; round++) {
      const [imported, bridge] = await Promise.all([
        state(["import-cloud-links"], exchange([`session_${round}`, null])),
        enterAsBridge(dir),
      ]);

      expect(imported.code === 0 && bridge.isOk()).toBe(false);
      if (bridge.isOk()) await rm(bridge.value.presence);
    }
  });

  test.each([
    { name: "a file that is not JSON", stdin: "{" },
    { name: "an unknown version", stdin: '{"version":2,"links":[]}' },
  ])("refuses $name as invalid", async ({ stdin }) => {
    const refused = await state(["import-cloud-links"], stdin);

    expect(refused.code).toBe(5);
  });
});
