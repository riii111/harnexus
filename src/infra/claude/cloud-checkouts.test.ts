import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../runtime/process.boundary.ts";
import { createCloudCheckouts } from "./cloud-checkouts.ts";

describe("createCloudCheckouts", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  const rooted = async () => {
    const root = await mkdtemp(join(tmpdir(), "harnexus-checkouts-"));
    roots.push(root);
    return root;
  };

  test("makes a checkout an empty repository whose origin is the GitHub repository", async () => {
    const checkouts = createCloudCheckouts(await rooted(), process.env);

    const taken = (await checkouts.take("riii111/harnexus")).unwrap();

    expect(await git(taken.dir, "config", "--get", "remote.origin.url")).toBe(
      "https://github.com/riii111/harnexus",
    );
    expect(await git(taken.dir, "status", "--porcelain")).toBe("");
    expect(
      await git(
        taken.dir,
        "config",
        "--get",
        "remote.origin.partialclonefilter",
      ),
    ).toBe("blob:none");
  });

  test("hands out a checkout as its last commit left it", async () => {
    const checkouts = createCloudCheckouts(await rooted(), process.env);
    const first = (await checkouts.take("riii111/harnexus")).unwrap();
    await writeFile(join(first.dir, "tracked.md"), "committed");
    await git(first.dir, "add", "tracked.md");
    await git(
      first.dir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "test: branch",
    );
    await writeFile(join(first.dir, "tracked.md"), "changed by a hook");
    await mkdir(join(first.dir, ".claude"));
    await writeFile(join(first.dir, ".claude", "settings.json"), "{}");
    first.release();

    const again = (await checkouts.take("riii111/harnexus")).unwrap();

    expect(again.dir).toBe(first.dir);
    expect(await git(again.dir, "status", "--porcelain", "--ignored")).toBe("");
    expect(await readFile(join(again.dir, "tracked.md"), "utf8")).toBe(
      "committed",
    );
  });

  test("gives each copy running at once its own checkout and hands a released one to the next", async () => {
    const root = await rooted();
    const checkouts = createCloudCheckouts(root, process.env);

    const [first, second] = await Promise.all([
      checkouts.take("riii111/harnexus"),
      checkouts.take("riii111/harnexus"),
    ]);
    first?.unwrap().release();
    const third = await checkouts.take("riii111/harnexus");

    const folder = join(root, "riii111", "harnexus");
    expect([first, second, third].map((taken) => taken?.unwrap().dir)).toEqual([
      join(folder, "0"),
      join(folder, "1"),
      join(folder, "0"),
    ]);
  });

  test("fails when its folder cannot be made", async () => {
    const root = await rooted();
    await writeFile(join(root, "file"), "");
    const checkouts = createCloudCheckouts(join(root, "file"), process.env);

    const taken = await checkouts.take("riii111/harnexus");

    expect(taken.isErr() && taken.error._tag).toBe("CheckoutFailed");
  });

  test("remembers the repository of a Cloud session", () => {
    const checkouts = createCloudCheckouts("/state/checkouts", {});

    checkouts.remember("session_01Nfj", "riii111/harnexus");

    expect(checkouts.repositoryOf("session_01Nfj")).toBe("riii111/harnexus");
    expect(checkouts.repositoryOf("session_02Abc")).toBeNull();
  });
});

const git = async (dir: string, ...args: string[]) =>
  (await runCommand("git", ["-C", dir, ...args], process.env))
    .unwrap()
    .stdout.trim();
