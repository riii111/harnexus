import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquire, milliseconds, release } from "./run-lock.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const lockIn = async () => {
  const root = await mkdtemp(join(tmpdir(), "harnexus-lock-"));
  roots.push(root);
  return join(root, "lock.json");
};

const DEAD_PID = 2 ** 22 + 999;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("acquire", () => {
  test("refuses a second run while a live run holds the lock, and takes it once released", async () => {
    const lock = await lockIn();

    const first = (await acquire(lock, "review")).unwrap();
    const second = await acquire(lock, "review");
    await release(lock, first);
    const third = await acquire(lock, "review");

    expect(second.isErr() && second.error.message).toContain("another review");
    expect(second.isErr() && second.error.message).not.toContain("remove");
    expect(third.isOk()).toBe(true);
  });

  test("takes over a dead holder's lock", async () => {
    const lock = await lockIn();
    await writeFile(lock, JSON.stringify({ pid: DEAD_PID, token: "dead" }));

    const taken = await acquire(lock, "review");

    expect(taken.isOk()).toBe(true);
    expect(await exists(`${lock}.reap`)).toBe(false);
  });

  test("leaves a dead taker's guard and the lock for the owner to clear, and names both", async () => {
    const lock = await lockIn();
    const guard = `${lock}.reap`;
    await writeFile(lock, JSON.stringify({ pid: DEAD_PID, token: "dead" }));
    await writeFile(guard, JSON.stringify({ pid: DEAD_PID + 1 }));

    const refused = await acquire(lock, "review");

    expect(refused.isErr() && refused.error.message).toContain(guard);
    expect(
      refused.isErr() && refused.error.message.replaceAll(guard, ""),
    ).toContain(lock);
    expect(await exists(lock)).toBe(true);
    expect(await exists(guard)).toBe(true);
  });

  test("lets no run hold the lock while a dead taker's guard remains", async () => {
    const lock = await lockIn();
    await writeFile(lock, JSON.stringify({ pid: DEAD_PID, token: "dead" }));
    await writeFile(`${lock}.reap`, JSON.stringify({ pid: DEAD_PID + 1 }));

    const together = await Promise.all([
      acquire(lock, "review"),
      acquire(lock, "review"),
    ]);
    const later = await acquire(lock, "review");

    expect([...together, later].map((run) => run.isOk())).toEqual([
      false,
      false,
      false,
    ]);
    expect(JSON.parse(await readFile(lock, "utf8")).token).toBe("dead");
  });

  test("keeps a live taker's guard and does not take the lock", async () => {
    const lock = await lockIn();
    const guard = `${lock}.reap`;
    await writeFile(lock, JSON.stringify({ pid: DEAD_PID, token: "dead" }));
    await writeFile(guard, JSON.stringify({ pid: process.pid }));

    const refused = await acquire(lock, "review");

    expect(refused.isErr() && refused.error.message).toContain(
      "is taking over",
    );
    expect(await exists(guard)).toBe(true);
    expect(await exists(lock)).toBe(true);
  });
});

describe("release", () => {
  test("leaves a lock another run took in the meantime", async () => {
    const lock = await lockIn();
    const mine = (await acquire(lock, "review")).unwrap();
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "other" }));

    await release(lock, mine);

    expect(JSON.parse(await readFile(lock, "utf8")).token).toBe("other");
  });
});

describe("milliseconds", () => {
  test.each([
    { name: "unset", value: undefined, expected: 5 },
    { name: "a positive number", value: "1200", expected: 1200 },
  ])("takes $name", ({ value, expected }) => {
    expect(milliseconds({ T: value }, "T", 5).unwrap()).toBe(expected);
  });

  test("refuses what is not a positive number", () => {
    expect(milliseconds({ T: "0" }, "T", 5).isErr()).toBe(true);
  });
});
