import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CloudLinkReservation,
  EMPTY_CLOUD_LINKS,
  exportCloudLinks,
  mergeCloudLinks,
  openCloudLinkReservations,
  parseCloudLinksExchange,
  readCloudLinks,
} from "./cloud-links.ts";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-cloud-links-"));
  path = join(dir, "cloud-links.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-06T00:00:00Z");

const link = (
  sessionId: string,
  threadId: string | null,
): CloudLinkReservation => ({
  sessionId,
  threadId,
  reservedAt: "2026-11-01T00:00:00Z",
});

describe("openCloudLinkReservations", () => {
  test("keeps a reservation and its chat across a restart", async () => {
    const first = openCloudLinkReservations(path);
    expect(await first.reserve("session_01A")).toEqual({ reserved: true });
    expect(await first.confirm("session_01A", "chat-a")).toBe(true);

    const later = openCloudLinkReservations(path);

    expect(await later.reserve("session_01A")).toEqual({
      reserved: false,
      threadId: "chat-a",
    });
  });

  test("keeps a reservation whose opening did not report back, so it is never made again", async () => {
    await openCloudLinkReservations(path).reserve("session_01A");

    const again = await openCloudLinkReservations(path).reserve("session_01A");

    expect(again).toEqual({ reserved: false, threadId: null });
  });

  test("frees a reservation only while it has no chat", async () => {
    const reservations = openCloudLinkReservations(path);
    await reservations.reserve("session_01A");
    await reservations.release("session_01A");
    await reservations.reserve("session_01B");
    await reservations.confirm("session_01B", "chat-b");
    await reservations.release("session_01B");

    const state = (await readCloudLinks(path)).unwrap();

    expect(state.links.map((l) => [l.sessionId, l.threadId])).toEqual([
      ["session_01B", "chat-b"],
    ]);
  });

  test("answers null for a file it cannot read, opening nothing over it", async () => {
    await writeFile(path, "not json");

    const reserved = await openCloudLinkReservations(path).reserve("s");

    expect(reserved).toBeNull();
    expect(await readFile(path, "utf8")).toBe("not json");
  });
});

describe("mergeCloudLinks", () => {
  test("adds the reservations the file lacks and counts those it holds", () => {
    const state = {
      ...EMPTY_CLOUD_LINKS,
      links: [link("session_01A", "chat-a")],
    };

    const { next, result } = mergeCloudLinks(
      state,
      [link("session_01A", "chat-a"), link("session_01B", null)],
      NOW,
    );

    expect(result).toEqual({
      imported: 1,
      present: 1,
      conflicts: [],
      alreadyImported: false,
    });
    expect(next?.links).toEqual([
      link("session_01A", "chat-a"),
      link("session_01B", null),
    ]);
    expect(next?.imports).toHaveLength(1);
  });

  test("takes nothing in when a session is reserved for another chat", () => {
    const state = {
      ...EMPTY_CLOUD_LINKS,
      links: [link("session_01A", "chat-a")],
    };

    const { next, result } = mergeCloudLinks(
      state,
      [link("session_01A", null), link("session_01B", "chat-b")],
      NOW,
    );

    expect(next).toBeNull();
    expect(result).toMatchObject({
      imported: 0,
      conflicts: [{ sessionId: "session_01A", kept: "chat-a", offered: null }],
    });
  });

  test("leaves the file as it was when the same file is imported again, keeping reservations made since", () => {
    const offered = [link("session_01A", "chat-a")];
    const first = mergeCloudLinks(EMPTY_CLOUD_LINKS, offered, NOW).next;
    const since = {
      ...first!,
      links: [...first!.links, link("session_01C", null)],
    };

    const again = mergeCloudLinks(since, [...offered].reverse(), NOW);

    expect(again).toEqual({
      next: null,
      result: { imported: 0, present: 1, conflicts: [], alreadyImported: true },
    });
  });
});

describe("exportCloudLinks", () => {
  test("writes what import reads, in session order, without the import marks", () => {
    const state = {
      ...EMPTY_CLOUD_LINKS,
      links: [link("session_01B", null), link("session_01A", "chat-a")],
      imports: [{ digest: "d", importedAt: "2026-11-02T00:00:00Z" }],
    };

    const text = exportCloudLinks(state);

    expect(JSON.parse(text)).toEqual({
      version: 1,
      links: [link("session_01A", "chat-a"), link("session_01B", null)],
    });
    expect(parseCloudLinksExchange(text).unwrap()).toHaveLength(2);
  });

  test.each([
    { name: "another version", text: '{"version":2,"links":[]}' },
    {
      name: "a session twice",
      text: JSON.stringify({
        version: 1,
        links: [link("s", "a"), link("s", "b")],
      }),
    },
    {
      name: "an unknown field",
      text: JSON.stringify({ version: 1, links: [], chats: [] }),
    },
  ])("refuses an exchange file with $name", ({ text }) => {
    expect(parseCloudLinksExchange(text).isErr()).toBe(true);
  });
});
