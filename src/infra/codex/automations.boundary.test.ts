import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAutomationIds, openCronRecord } from "./automations.boundary.ts";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-cron-record-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("openCronRecord", () => {
  test("keeps added ids across reopening until they are removed", async () => {
    const path = join(dir, "kept.json");
    const record = openCronRecord(path);

    await Promise.all([record.add("first"), record.add("second")]);
    await record.add("first");
    const reopened = openCronRecord(path);
    const before = await reopened.has("second");
    await reopened.remove("second");

    expect(before.unwrap()).toBe(true);
    expect((await record.has("first")).unwrap()).toBe(true);
    expect((await record.has("second")).unwrap()).toBe(false);
  });

  test("holds no id before anything is recorded", async () => {
    const record = openCronRecord(join(dir, "never-written.json"));

    const found = await record.has("nightly");

    expect(found.unwrap()).toBe(false);
  });

  test("reports a file in another format as an error rather than as empty", async () => {
    const path = join(dir, "corrupt.json");
    await writeFile(path, JSON.stringify({ version: 1, ids: [1] }));

    const found = await openCronRecord(path).has("nightly");

    expect(found.isErr()).toBe(true);
  });
});

describe("listAutomationIds", () => {
  test("lists nothing when the app has no automations folder", async () => {
    const listed = await listAutomationIds(join(dir, "no-codex-home"));

    expect(listed.unwrap()).toEqual([]);
  });
});
