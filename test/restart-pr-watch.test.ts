import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "restart-pr-watch.sh");

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A launchctl that records its calls and answers print as loaded or not.
const run = async (launchctl: "loaded" | "unloaded" | "missing") => {
  const dir = await mkdtemp(join(tmpdir(), "harnexus-restart-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const calls = join(dir, "calls");
  await writeFile(calls, "");
  if (launchctl !== "missing") {
    await writeFile(
      join(dir, "launchctl"),
      `#!/usr/bin/env bash\necho "$*" >> "${calls}"\n[[ "$1" != print || "${launchctl}" == loaded ]]\n`,
    );
    await chmod(join(dir, "launchctl"), 0o755);
  }
  const ran = Bun.spawnSync(["/bin/bash", SCRIPT], {
    env: { PATH: `${dir}:/usr/bin:/bin` },
  });
  return {
    code: ran.exitCode,
    out: ran.stdout.toString(),
    calls: (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean),
  };
};

describe("restart-pr-watch.sh", () => {
  test("restarts a loaded PR watch", async () => {
    const { code, out, calls } = await run("loaded");

    const service = `gui/${process.getuid?.()}/io.github.riii111.pr-watch`;
    expect([code, calls]).toEqual([
      0,
      [`print ${service}`, `kickstart -k ${service}`],
    ]);
    expect(out).toContain("restarted io.github.riii111.pr-watch");
  });

  test.each([
    { name: "an unloaded PR watch", launchctl: "unloaded" as const },
    { name: "a system without launchctl", launchctl: "missing" as const },
  ])("leaves $name alone", async ({ launchctl }) => {
    const { code, out, calls } = await run(launchctl);

    expect(code).toBe(0);
    expect(calls.some((call) => call.startsWith("kickstart"))).toBe(false);
    expect(out).toContain("nothing to restart");
  });
});
