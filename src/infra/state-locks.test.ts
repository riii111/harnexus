import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLock,
  enterAsBridge,
  enterMaintenance,
  type LockDeps,
} from "./state-locks.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-locks-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Processes are told apart by pid alone, and only those listed as alive are.
const processes = (alive: number[]) => {
  const live = new Set(alive);
  let tokens = 0;
  const as = (pid: number): LockDeps => ({
    pid,
    alive: (other) => live.has(other),
    newToken: () => `token-${++tokens}`,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  return { live, as };
};

const presences = async () =>
  (await readdir(join(dir, "bridges")).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  );

describe("enterAsBridge and enterMaintenance", () => {
  test("keeps a bridge from starting while a live operation holds the state, leaving no presence", async () => {
    const { as } = processes([100, 200]);
    const maintenance = (await enterMaintenance(dir, as(100))).unwrap();

    const bridge = await enterAsBridge(dir, as(200));

    expect(bridge.isErr() && bridge.error._tag).toBe("MaintenanceRunning");
    expect(await presences()).toEqual([]);
    await maintenance.release();
    expect((await enterAsBridge(dir, as(200))).isOk()).toBe(true);
  });

  test("refuses an operation while a live bridge is present, and frees the lock it took", async () => {
    const { as, live } = processes([100, 200]);
    (await enterAsBridge(dir, as(200))).unwrap();

    const refused = await enterMaintenance(dir, as(100));

    expect(refused.isErr() && refused.error._tag).toBe("BridgesRunning");
    expect(refused.isErr() && refused.error.message).toContain("200");
    live.delete(200);
    expect((await enterMaintenance(dir, as(100))).isOk()).toBe(true);
  });

  test("refuses a second operation while the first one runs", async () => {
    const { as } = processes([100, 101]);
    (await enterMaintenance(dir, as(100))).unwrap();

    const second = await enterMaintenance(dir, as(101));

    expect(second.isErr() && second.error._tag).toBe("MaintenanceRunning");
  });

  test("passes over the presence of a bridge that exited and removes it", async () => {
    const { as } = processes([100]);
    (await enterAsBridge(dir, as(300))).unwrap();

    const entered = await enterMaintenance(dir, as(100));

    expect(entered.isOk()).toBe(true);
    expect(await presences()).toEqual([]);
  });

  test("lets a bridge start over the lock of an operation that exited", async () => {
    const { as } = processes([200]);
    (await enterMaintenance(dir, as(400))).unwrap();

    expect((await enterAsBridge(dir, as(200))).isOk()).toBe(true);
  });

  test("takes over the lock of an operation that exited", async () => {
    const { as } = processes([100]);
    (await enterMaintenance(dir, as(400))).unwrap();

    const entered = await enterMaintenance(dir, as(100));

    expect(entered.isOk()).toBe(true);
  });

  test("never lets a bridge and an operation that start at once both go on", async () => {
    const { as } = processes([100, 200]);
    for (let round = 0; round < 40; round++) {
      const [bridge, maintenance] = await Promise.all([
        enterAsBridge(dir, as(200)),
        enterMaintenance(dir, as(100)),
      ]);

      expect(bridge.isOk() && maintenance.isOk()).toBe(false);
      if (maintenance.isOk()) await maintenance.value.release();
      if (bridge.isOk()) await rm(bridge.value.presence);
    }
  });

  test("keeps a bridge out while the lock cannot be read", async () => {
    const { as } = processes([200]);
    await writeFile(join(dir, "maintenance.lock"), "written by hand");

    const bridge = await enterAsBridge(dir, as(200));

    expect(bridge.isErr() && bridge.error._tag).toBe("MaintenanceRunning");
  });
});

describe("acquireLock", () => {
  test("waits for a live holder to release the lock", async () => {
    const { as } = processes([100, 101]);
    const path = join(dir, "state.lock");
    const first = (await acquireLock(path, 0, as(100))).unwrap();

    const second = acquireLock(path, 2_000, as(101));
    await first.release();

    expect((await second).isOk()).toBe(true);
  });

  test("answers a live holder's pid once the wait is over", async () => {
    const { as } = processes([100, 101]);
    const path = join(dir, "state.lock");
    (await acquireLock(path, 0, as(100))).unwrap();

    const second = await acquireLock(path, 50, as(101));

    expect(second.isErr() && second.error._tag === "StateLockBusy").toBe(true);
    expect(second.isErr() && "pid" in second.error && second.error.pid).toBe(
      100,
    );
  });

  test("gives the lock of an exited holder to one taker at a time", async () => {
    const { as } = processes([101, 102]);
    const path = join(dir, "state.lock");
    (await acquireLock(path, 0, as(400))).unwrap();

    const [a, b] = await Promise.all([
      acquireLock(path, 0, as(101)),
      acquireLock(path, 0, as(102)),
    ]);

    expect([a.isOk(), b.isOk()].filter(Boolean)).toHaveLength(1);
  });
});
