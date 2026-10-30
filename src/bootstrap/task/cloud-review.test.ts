import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, TASK_DEPS } from "./cli.ts";

const SKILLS = join(import.meta.dir, "../../../test/fixtures/task-skills");
const README = join(import.meta.dir, "../../../README.md");
const REVIEWER = "01a18d52-e03a-74c1-a50e-4e697b47172b";
const OTHER = "01a18d52-e03a-74c1-a50e-4e697b47172c";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A stand-in for codex: records its arguments, directory and stdin, then prints the next planned output.
const SCRIPT = `#!/usr/bin/env bash
dir="$FAKE_DIR"
n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/count"
printf '%s\\n' "$@" > "$dir/args.$n"
pwd > "$dir/cwd.$n"
cat > "$dir/stdin.$n"
if [ -f "$dir/sleep.$n" ]; then sleep "$(cat "$dir/sleep.$n")"; fi
if [ -f "$dir/stderr.$n" ]; then cat "$dir/stderr.$n" >&2; fi
cat "$dir/out.$n" 2>/dev/null
exit "$(cat "$dir/exit.$n" 2>/dev/null || echo 0)"
`;

const events = (threadId: string, answer: string) =>
  [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: answer },
    },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

const fixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harnexus-cloud-review-")),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "fake");
  const checkout = join(root, "repo");
  await mkdir(fake);
  await mkdir(checkout);
  const bin = join(root, "codex");
  await writeFile(bin, SCRIPT);
  await chmod(bin, 0o755);
  await mkdir(join(root, "config/harnexus"), { recursive: true });
  await writeFile(
    join(root, "config/harnexus/task.json"),
    JSON.stringify({
      templates: {
        reviewer: join(SKILLS, "task-review-cycle/references/reviewer.md"),
      },
    }),
  );
  const git = (...args: string[]) => {
    const ran = Bun.spawnSync(
      [
        "git",
        "-C",
        checkout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { stderr: "pipe" },
    );
    expect(ran.exitCode).toBe(0);
    return ran.stdout.toString().trim();
  };
  const commit = (message: string) => {
    git("commit", "--allow-empty", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const initial = commit("test: initial");
  git("branch", "base");
  const env = {
    CLAUDE_CODE_REMOTE: "true",
    CLAUDE_CODE_SESSION_ID: "worker-session",
    HARNEXUS_CODEX_BIN: bin,
    FAKE_DIR: fake,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    PATH: process.env.PATH,
  };
  const request = join(root, "request.json");
  await writeFile(
    request,
    JSON.stringify({
      taskId: "example",
      workerAI: "Claude",
      projectId: "project",
      checkout,
      baseBranch: "base",
      documentRefs: [README],
      prUrl: null,
    }),
  );
  const plan = (
    n: number,
    {
      out = "",
      exit = 0,
      stderr,
    }: { out?: string; exit?: number; stderr?: string },
  ) =>
    Promise.all([
      writeFile(join(fake, `out.${n}`), out),
      writeFile(join(fake, `exit.${n}`), String(exit)),
      stderr === undefined
        ? Promise.resolve()
        : writeFile(join(fake, `stderr.${n}`), stderr),
    ]);
  const review = async (
    extra: string[] = [],
    more: Record<string, string> = {},
  ) => {
    const done = await runTask(["review", "--request", request, ...extra], {
      ...TASK_DEPS,
      env: { ...env, ...more },
    });
    return {
      code: done.code,
      out: done.code === 0 ? JSON.parse(done.stdout) : null,
      err: done.stderr,
    };
  };
  const args = async (n: number) =>
    (await readFile(join(fake, `args.${n}`), "utf8")).trim().split("\n");
  const input = (n: number) => readFile(join(fake, `stdin.${n}`), "utf8");
  const cwd = async (n: number) =>
    (await readFile(join(fake, `cwd.${n}`), "utf8")).trim();
  const calls = async () =>
    (await readdir(fake)).filter((name) => name.startsWith("args.")).length;
  return {
    root,
    fake,
    checkout,
    commit,
    initial,
    plan,
    review,
    args,
    input,
    cwd,
    calls,
  };
};

describe("harnexus-task review in a Claude Code cloud session", () => {
  test("reviews the first head with a new reviewer and answers with its result, from a checkout outside the app's worktrees", async () => {
    const { checkout, commit, initial, plan, review, args, input } =
      await fixture();
    const head = commit("test: candidate");
    await plan(1, { out: events(REVIEWER, "判定: LGTM\n対象: …") });

    const done = await review();

    expect(done.err).toBe("");
    expect(done.out).toEqual({
      status: "completed",
      verdict: "LGTM",
      taskId: "example",
      base: initial,
      head,
      reviewer: REVIEWER,
      answer: "判定: LGTM\n対象: …",
      state: expect.stringContaining("cloud-review"),
    });
    expect(await args(1)).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "-C",
      checkout,
      "-m",
      "gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="medium"',
      "-",
    ]);
    expect(checkout).not.toContain("worktrees");
    const prompt = await input(1);
    expect(prompt).toContain(`${initial}...${head}`);
    expect(prompt).toContain("workerのチャットID: worker-session");
    expect(prompt).toContain("references/reply-Cloud.md");
  });

  test("re-reviews a new head by resuming the same reviewer in the checkout", async () => {
    const { checkout, commit, initial, plan, review, args, cwd } =
      await fixture();
    commit("test: candidate");
    await plan(1, { out: events(REVIEWER, "判定: 修正必要") });
    expect((await review()).out.verdict).toBe("修正必要");
    const fixed = commit("fix: candidate");
    await plan(2, { out: events(REVIEWER, "判定: LGTM") });

    const done = await review();

    expect(done.out).toMatchObject({
      verdict: "LGTM",
      base: initial,
      head: fixed,
      reviewer: REVIEWER,
    });
    expect(await args(2)).toEqual([
      "exec",
      "resume",
      REVIEWER,
      "--json",
      "-c",
      'sandbox_mode="read-only"',
      "-",
    ]);
    expect(await cwd(2)).toBe(checkout);
  });

  test("refuses a head it already reviewed", async () => {
    const { commit, plan, review, calls } = await fixture();
    const head = commit("test: candidate");
    await plan(1, { out: events(REVIEWER, "判定: LGTM") });
    await review();

    const again = await review();

    expect([again.code, again.err]).toEqual([
      1,
      expect.stringContaining(`head ${head} was already reviewed`),
    ]);
    expect(await calls()).toBe(1);
  });

  test("leaves nothing pending after a turn that failed, so the head is sent again", async () => {
    const { commit, plan, review, args } = await fixture();
    commit("test: candidate");
    await plan(1, {
      out: [
        JSON.stringify({ type: "thread.started", thread_id: OTHER }),
        JSON.stringify({
          type: "turn.failed",
          error: { message: "unexpected status 401 Unauthorized" },
        }),
      ].join("\n"),
      exit: 1,
    });

    const failed = await review();

    expect([failed.code, failed.err]).toEqual([
      1,
      expect.stringContaining("401 Unauthorized"),
    ]);
    await plan(2, { out: events(REVIEWER, "判定: 判定保留") });
    expect((await review()).out).toMatchObject({
      reviewer: REVIEWER,
      verdict: "判定保留",
    });
    expect((await args(2)).slice(0, 2)).toEqual(["exec", "--json"]);
  });

  test("starts a new reviewer once the old one is gone from the machine", async () => {
    const { commit, plan, review, args } = await fixture();
    commit("test: candidate");
    await plan(1, { out: events(REVIEWER, "判定: 修正必要") });
    await review();
    commit("fix: candidate");
    await plan(2, {
      exit: 1,
      stderr: `Error: thread/resume: thread/resume failed: no rollout found for thread id ${REVIEWER} (code -32600)\n`,
    });

    const gone = await review();

    expect([gone.code, gone.err]).toEqual([
      1,
      expect.stringContaining("start a new reviewer"),
    ]);
    await plan(3, { out: events(OTHER, "判定: LGTM") });
    expect((await review()).out.reviewer).toBe(OTHER);
    expect((await args(3)).slice(0, 2)).toEqual(["exec", "--json"]);
  });

  test("keeps a review whose result is unknown pending until it is discarded", async () => {
    const { fake, commit, plan, review, calls } = await fixture();
    commit("test: candidate");
    await writeFile(join(fake, "sleep.1"), "5");
    await plan(1, { out: events(REVIEWER, "判定: LGTM") });

    const lost = await review([], {
      HARNEXUS_REVIEW_TIMEOUT_MS: "300",
      HARNEXUS_REVIEW_KILL_GRACE_MS: "100",
    });

    expect([lost.code, lost.err]).toEqual([
      1,
      expect.stringContaining("--recover discard"),
    ]);
    const held = await review();
    expect([held.code, held.err]).toEqual([
      1,
      expect.stringContaining("did not report back"),
    ]);
    expect(await calls()).toBe(1);
    await plan(2, { out: events(REVIEWER, "判定: LGTM") });
    expect((await review(["--recover", "discard"])).out.verdict).toBe("LGTM");
  });
});
