import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { holdProcessLock } from "../../../runtime/fs.boundary.ts";
import { saveJson } from "../session.ts";
import { dryRun, release, watchForever } from "./commands.ts";
import type { GitHub, PrDetail } from "./github.ts";
import {
  freshState,
  loadWatchState,
  lockPath,
  recordLink,
  saveWatchState,
} from "./store.ts";

const PR = "https://github.com/org/pay/pull/7";
const REF = { repo: "org/pay", number: 7 };
const LINK = {
  ...REF,
  url: PR,
  worker: "worker",
  linkedAt: "2026-09-01T00:00:00Z",
};

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "harnexus-watch-commands-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const env = {
    HOME: root,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
  };
  await mkdir(join(root, "config/harnexus"), { recursive: true });
  await writeFile(
    join(root, "config/harnexus/pr-watch.json"),
    JSON.stringify({
      repositories: { "Org/Pay": { account: "owner" } },
      ignore: [{ author: "coderabbitai[bot]", kind: "issue_comment" }],
    }),
  );
  return { env };
};

const detail: PrDetail = {
  state: "OPEN",
  isDraft: false,
  head: "a".repeat(40),
  updatedAt: "2026-10-23T00:00:00Z",
  mergeable: "MERGEABLE",
  coderabbit: {
    state: "SUCCESS",
    description: "Review completed",
    createdAt: "2026-10-01T00:00:00Z",
  },
  rollup: "SUCCESS",
  url: PR,
  title: "Pay",
  failedRequired: [],
  noActionableSummary: false,
  comments: [
    {
      id: "inline:1",
      kind: "inline",
      author: "coderabbitai[bot]",
      url: `${PR}#discussion_r1`,
      createdAt: "2026-10-01T00:00:00Z",
      body: "**🟡 Minor**",
      path: "a.kt",
      line: 3,
      reply: false,
      resolved: false,
    },
    {
      id: "issue:2",
      kind: "issue_comment",
      author: "coderabbitai[bot]",
      url: `${PR}#issuecomment-2`,
      createdAt: "2026-10-01T00:00:00Z",
      body: "walkthrough",
      path: null,
      line: null,
      reply: false,
      resolved: false,
    },
  ],
};

const github = (asked: string[]): GitHub => ({
  summaries: async () => Result.ok([]),
  detail: async (account, ref) => {
    asked.push(`${account} ${ref.repo}#${ref.number}`);
    return Result.ok(detail);
  },
  openPulls: async (account, repo) => {
    asked.push(`open ${account} ${repo}`);
    return Result.ok([{ repo, number: 7 }]);
  },
});

describe("dryRun", () => {
  test("reports the verdicts and the message for every open PR the watch already read without writing its state", async () => {
    const { env } = await fixture();
    await recordLink(env, saveJson, LINK);
    const read = { ...freshState(), summary: detail };
    await saveWatchState(env, saveJson, REF, read);
    const asked: string[] = [];

    const ran = await dryRun({ env, github: github(asked) }, []);

    const report = ran.unwrap().prs as Record<string, unknown>[];
    expect(asked).toEqual(["open owner org/pay", "owner org/pay#7"]);
    expect((await loadWatchState(env, REF)).unwrap()).toEqual(read);
    expect(report[0]?.firstRead).toBe(false);
    expect(report[0]?.ignored).toEqual([
      {
        id: "issue:2",
        author: "coderabbitai[bot]",
        kind: "issue_comment",
        reason: "ignore rule",
        url: `${PR}#issuecomment-2`,
      },
    ]);
    expect(String(report[0]?.prompt)).toContain(
      `1. [CodeRabbit・Minor] a.kt:3 ${PR}#discussion_r1`,
    );
  });

  test.each([
    { name: "a linked PR without watch state", linked: true },
    { name: "a PR no worker linked", linked: false },
  ])("shows $name as a first read with no message and writes no state", async ({
    linked,
  }) => {
    const { env } = await fixture();
    if (linked) await recordLink(env, saveJson, LINK);

    const ran = await dryRun({ env, github: github([]) }, [PR]);

    const [report] = ran.unwrap().prs as Record<string, unknown>[];
    expect([report?.firstRead, report?.prompt]).toEqual([true, null]);
    expect((report?.notified as unknown[]).length).toBe(1);
    expect((await loadWatchState(env, REF)).unwrap()).toEqual(freshState());
  });

  test("reads only the given PRs and refuses a repository outside the config", async () => {
    const { env } = await fixture();
    const asked: string[] = [];

    const given = await dryRun({ env, github: github(asked) }, [`${PR}/files`]);
    const outside = await dryRun({ env, github: github(asked) }, [
      "https://github.com/org/other/pull/1",
    ]);

    expect(given.isOk()).toBe(true);
    expect(asked).toEqual(["owner org/pay#7"]);
    expect(outside.isErr() && outside.error.message).toContain(
      "org/other is not in the repositories",
    );
  });
});

describe("release", () => {
  test("resumes a halted PR and takes its message as delivered", async () => {
    const { env } = await fixture();
    const ref = { repo: "org/pay", number: 7 };
    await recordLink(env, saveJson, {
      ...ref,
      url: PR,
      worker: "worker",
      linkedAt: "2026-10-01T00:00:00Z",
    });
    await saveWatchState(env, saveJson, ref, {
      ...freshState(),
      status: "halted",
      pending: [{ type: "conflict", head: "a" }],
      halted: { prompt: "x" },
    });

    const released = await release(env, saveJson, PR);
    const again = await release(env, saveJson, PR);

    const state = (await loadWatchState(env, ref)).unwrap();
    expect(released.unwrap()).toEqual({ released: PR, worker: "worker" });
    expect([state.status, state.pending, state.halted]).toEqual([
      "watching",
      [],
      null,
    ]);
    expect(again.isErr() && again.error.message).toContain("is not halted");
  });
});

// The lock comes from macOS's O_EXLOCK, which other systems do not have.
const onMac = process.platform === "darwin";

describe("watchForever", () => {
  test.skipIf(!onMac)(
    "refuses to start while another watch holds the lock",
    async () => {
      const { env } = await fixture();
      await mkdir(join(env.XDG_STATE_HOME, "taskctl/watch"), {
        recursive: true,
      });
      expect(holdProcessLock(lockPath(env)).unwrap()).toBe(true);

      const ran = await watchForever(
        {
          env,
          saveJson,
          github: github([]),
          callApp: async () => ({ outcome: "done" }),
          now: () => new Date(),
          log: () => {},
        },
        async () => {},
      );

      expect(ran.isErr() && ran.error.message).toBe(
        "another harnexus-task watch is running",
      );
    },
  );
});
