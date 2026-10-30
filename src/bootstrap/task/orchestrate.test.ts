import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, TASK_DEPS } from "./cli.ts";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A stand-in for claude-cloud: runs do.N in its directory (to commit work), then answers with the session it was given.
const CLAUDE = `#!/usr/bin/env bash
dir="$FAKE_DIR"
n=$(( $(cat "$dir/claude.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/claude.count"
printf '%s\\n' "$@" > "$dir/claude.args.$n"
cat > "$dir/claude.stdin.$n"
sid=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--session-id" ] || [ "$prev" = "--resume" ]; then sid="$a"; fi
  prev="$a"
done
if [ -f "$dir/do.$n" ]; then bash "$dir/do.$n" >&2 || exit 3; fi
if [ -f "$dir/lost.$n" ]; then exit 9; fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"done %s","session_id":"%s"}' "$n" "$sid"
`;

// A stand-in for gh: one JSON file per head branch, so a listing finds only that branch's pull request.
const GH = `#!/usr/bin/env bash
dir="$FAKE_DIR"
echo "$*" >> "$dir/gh.log"
head=""; base=""; draft=no; prev=""
for a in "$@"; do
  case "$prev" in --head) head=$a;; --base) base=$a;; esac
  if [ "$a" = "--draft" ]; then draft=yes; fi
  prev=$a
done
file="$dir/pr.$(echo "$head" | tr / _)"
case "$1 $2" in
  "pr list")
    if [ -f "$dir/gh.listfail" ]; then echo "network down" >&2; exit 1; fi
    if [ -f "$file" ]; then echo "[$(cat "$file")]"; else echo "[]"; fi ;;
  "pr create")
    [ "$draft" = yes ] || exit 5
    n=$(( $(cat "$dir/gh.creates" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$dir/gh.creates"
    printf '{"url":"https://github.com/o/r/pull/%s","state":"OPEN","isDraft":true,"baseRefName":"%s","headRefOid":"%s"}' "$n" "$base" "$(git rev-parse HEAD)" > "$file"
    if [ -f "$dir/gh.createfail" ]; then echo "timeout" >&2; exit 1; fi
    echo "https://github.com/o/r/pull/$n" ;;
  *) exit 4 ;;
esac
`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "harnexus-orch-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "fake");
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  await mkdir(fake);
  await mkdir(bin);
  await writeFile(join(bin, "claude-cloud"), CLAUDE);
  await writeFile(join(bin, "gh"), GH);
  await chmod(join(bin, "claude-cloud"), 0o755);
  await chmod(join(bin, "gh"), 0o755);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "base\n");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "base",
  );
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  const env = {
    CODEX_THREAD_ID: "thread-1",
    HARNEXUS_CLAUDE_CLOUD_BIN: join(bin, "claude-cloud"),
    FAKE_DIR: fake,
    XDG_STATE_HOME: join(root, "state"),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    PATH: `${bin}:${process.env.PATH}`,
  };
  const issues = [
    {
      id: "api",
      instruction: "Build the api",
      dependsOn: [],
      test: ["test", "-f", "api.txt"],
      title: "feat: api",
      body: "Adds the api.",
    },
    {
      id: "ui",
      instruction: "Build the ui",
      dependsOn: ["api"],
      test: ["test", "-f", "ui.txt"],
      title: "feat: ui",
      body: "Adds the ui.",
    },
  ];
  const planPath = join(root, "plan.json");
  const writePlan = (changes: Record<string, unknown> = {}) =>
    writeFile(
      planPath,
      JSON.stringify({
        planId: "demo",
        repository: repo,
        baseRef: "main",
        issues,
        ...changes,
      }),
    );
  await writePlan();
  const run = async (
    argv: readonly string[],
    extra: Record<string, string> = {},
  ) => {
    const done = await runTask(
      ["orchestrate", "--request", planPath, ...argv],
      {
        ...TASK_DEPS,
        env: { ...env, ...extra },
      },
    );
    return {
      code: done.code,
      out: done.code === 0 ? JSON.parse(done.stdout) : null,
      err: done.stderr,
    };
  };
  const commitsOn = async (n: number, file: string) =>
    writeFile(
      join(fake, `do.${n}`),
      `echo ${file} > ${file}.txt && git add ${file}.txt && git commit -qm ${file}\n`,
    );
  const status = async (id: string) => {
    const { out } = await run([]);
    return out.issues.find((issue: { id: string }) => issue.id === id);
  };
  const reviewFile = async (name: string, review: Record<string, unknown>) => {
    const path = join(root, `${name}.json`);
    await writeFile(path, JSON.stringify(review));
    return path;
  };
  const read = (name: string) => readFile(join(fake, name), "utf8");
  const text = (name: string, content: string) => {
    const path = join(root, name);
    return writeFile(path, content).then(() => path);
  };
  return {
    root,
    fake,
    repo,
    remote,
    planPath,
    writePlan,
    run,
    commitsOn,
    status,
    reviewFile,
    read,
    text,
    issues,
  };
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

// Takes one issue from its start to a tested candidate and returns its head.
const candidateOf = async (f: Fixture, id: string, turn: number) => {
  await f.commitsOn(turn, id);
  expect((await f.run(["--work", id])).code).toBe(0);
  const done = await f.run(["--candidate", id]);
  expect(done.err).toBe("");
  const { base, head } = done.out.action;
  return { base, head } as { base: string; head: string };
};

describe("harnexus-task orchestrate", () => {
  test("carries two dependent issues from a plan to Draft PRs through the CLI", async () => {
    const f = await fixture();
    const before = await f.run([]);
    expect(before.out.issues.map((i: { status: string }) => i.status)).toEqual([
      "unprepared",
      "blocked",
    ]);

    const prepared = await f.run(["--prepare"]);
    expect(prepared.out.action).toEqual({
      created: ["api"],
      reused: [],
      waiting: ["ui"],
    });
    const api = await f.status("api");
    expect(git(f.repo, "branch", "--list", "harnexus/demo/api")).toContain(
      "api",
    );
    expect(api.worktree).not.toBe(f.repo);
    expect((await f.run(["--prepare"])).out.action).toMatchObject({
      created: [],
      reused: ["api"],
    });

    const first = await candidateOf(f, "api", 1);
    expect(first.base).toBe(git(f.repo, "rev-parse", "main"));
    expect(await f.read("claude.stdin.1")).toContain("Build the api");
    const again = await f.run(["--work", "api"]);
    expect(again.err).toContain("never sent twice");
    expect(await f.read("claude.count")).toBe("1\n");

    const stale = await f.reviewFile("stale", {
      reviewerId: "R1",
      base: first.base,
      head: "0".repeat(40),
      verdict: "lgtm",
    });
    expect(
      (await f.run(["--review", "api", "--review-file", stale])).err,
    ).toContain("review the current head");
    const requested = await f.reviewFile("changes", {
      reviewerId: "R1",
      ...first,
      verdict: "changes_requested",
      findings: [{ file: "api.txt", note: "rename" }],
    });
    const asked = await f.run(["--review", "api", "--review-file", requested]);
    expect(asked.out.action).toMatchObject({ recorded: true });
    expect(
      await f.run(["--review", "api", "--review-file", requested]),
    ).toMatchObject({
      out: { action: { recorded: false } },
    });
    const wait = await f.status("api");
    expect(wait).toMatchObject({
      status: "changes_requested",
      next: "work",
      reviewerId: "R1",
    });
    expect(wait.lastReview.findings).toEqual([
      { file: "api.txt", note: "rename" },
    ]);
    expect((await f.run(["--publish", "api"])).err).toContain(
      "independent LGTM",
    );

    const fix = await f.text("fix.md", "Rename it");
    await writeFile(
      join(f.fake, "do.2"),
      "echo more >> api.txt && git commit -qam fix\n",
    );
    expect(
      (await f.run(["--work", "api", "--prompt-file", fix])).out.action,
    ).toMatchObject({
      resumed: true,
    });
    expect(await f.read("claude.args.2")).toContain("--resume");
    expect(await f.read("claude.stdin.2")).toBe("Rename it");
    const { base, head } = (await f.run(["--candidate", "api"])).out.action;
    const second = { base, head };
    expect(second.head).not.toBe(first.head);

    const oldLgtm = await f.reviewFile("old", {
      reviewerId: "R1",
      ...first,
      verdict: "lgtm",
    });
    expect(
      (await f.run(["--review", "api", "--review-file", oldLgtm])).err,
    ).toContain("review the current head");
    const other = await f.reviewFile("other", {
      reviewerId: "R2",
      ...second,
      verdict: "lgtm",
    });
    expect(
      (await f.run(["--review", "api", "--review-file", other])).err,
    ).toContain("reviewed by R1");
    const good = await f.reviewFile("good", {
      reviewerId: "R1",
      ...second,
      verdict: "lgtm",
    });
    expect(
      (await f.run(["--review", "api", "--review-file", good])).out,
    ).toMatchObject({ runnable: ["api", "ui"] });
    expect((await f.status("ui")).next).toBe("prepare");

    const published = await f.run(["--publish", "api"]);
    expect(published.out.action).toMatchObject({
      prUrl: "https://github.com/o/r/pull/1",
      isDraft: true,
    });
    expect(git(f.remote, "rev-parse", "harnexus/demo/api")).toBe(second.head);
    expect(await f.read("gh.log")).toContain(
      "--draft --base main --head harnexus/demo/api",
    );
    expect((await f.run(["--publish", "api"])).out.action).toMatchObject({
      recorded: false,
    });
    expect(await f.read("gh.creates")).toBe("1\n");

    expect((await f.run(["--prepare"])).out.action).toMatchObject({
      created: ["ui"],
    });
    const ui = await f.status("ui");
    expect(git(ui.worktree, "rev-parse", "HEAD")).toBe(second.head);
    expect(ui.worktree).not.toBe(api.worktree);
    expect(
      (await f.run(["--work", "api", "--prompt-file", fix])).err,
    ).toContain("approved");
    const uiHead = await candidateOf(f, "ui", 3);
    const uiLgtm = await f.reviewFile("ui", {
      reviewerId: "R3",
      ...uiHead,
      verdict: "lgtm",
    });
    await f.run(["--review", "ui", "--review-file", uiLgtm]);
    const uiPr = await f.run(["--publish", "ui"]);
    expect(uiPr.out.action).toMatchObject({
      prUrl: "https://github.com/o/r/pull/2",
    });
    expect(await f.read("gh.log")).toContain(
      "--base harnexus/demo/api --head harnexus/demo/ui",
    );
    expect(
      (await f.run([])).out.issues.map((i: { status: string }) => i.status),
    ).toEqual(["published", "published"]);
  });

  test("does not make a candidate of uncommitted work or a failing test", async () => {
    const f = await fixture();
    await f.run(["--prepare"]);
    const api = await f.status("api");
    await writeFile(join(api.worktree, "api.txt"), "x");
    expect((await f.run(["--candidate", "api"])).err).toContain("uncommitted");
    git(api.worktree, "add", "-A");
    git(api.worktree, "commit", "-qm", "wip");
    await rm(join(api.worktree, "api.txt"));
    git(api.worktree, "commit", "-qam", "drop");
    git(api.worktree, "commit", "-q", "--allow-empty", "-m", "empty");
    const failed = await f.run(["--candidate", "api"]);
    expect(failed.err).toContain("tests failed");
    const after = await f.status("api");
    expect(after).toMatchObject({ head: null, lastTest: { ok: false } });
    expect(after.next).toBe("work");
  });

  test("never repeats a push or a pull request whose result is unknown", async () => {
    const f = await fixture();
    await f.run(["--prepare"]);
    const { base, head } = await candidateOf(f, "api", 1);
    const lgtm = await f.reviewFile("lgtm", {
      reviewerId: "R1",
      base,
      head,
      verdict: "lgtm",
    });
    await f.run(["--review", "api", "--review-file", lgtm]);

    await writeFile(join(f.fake, "gh.listfail"), "");
    const blind = await f.run(["--publish", "api"]);
    expect(blind.err).toContain("cannot read the pull requests");
    expect(git(f.remote, "branch", "--list", "harnexus/*")).toBe("");
    await rm(join(f.fake, "gh.listfail"));

    await writeFile(join(f.fake, "gh.createfail"), "");
    const body = await f.text("body.md", "Custom body");
    const lost = await f.run(["--publish", "api", "--body-file", body]);
    expect(lost.out.action).toMatchObject({
      prUrl: "https://github.com/o/r/pull/1",
    });
    expect(await f.read("gh.creates")).toBe("1\n");
  });

  test("refuses a second worker start after a turn whose result is lost", async () => {
    const f = await fixture();
    await f.run(["--prepare"]);
    await writeFile(join(f.fake, "lost.1"), "");
    const lost = await f.run(["--work", "api"]);
    expect(lost.code).toBe(1);
    const retry = await f.run(["--work", "api"]);
    expect(retry.err).toContain("did not report back");
    expect(await f.read("claude.count")).toBe("1\n");
    expect((await f.status("api")).worker).toMatchObject({ pending: true });
  });

  test("rejects a plan whose dependencies cannot be built or whose meaning changed", async () => {
    const f = await fixture();
    const [api, ui] = f.issues;
    await f.writePlan({
      issues: [{ ...api, dependsOn: ["ui"] }, ui],
    });
    expect((await f.run([])).err).toContain("dependency cycle");
    await f.writePlan({ issues: [{ ...ui, dependsOn: ["nope"] }] });
    expect((await f.run([])).err).toContain("unknown nope");
    const join3 = { ...api, id: "all", dependsOn: ["api", "ui"] };
    await f.writePlan({ issues: [api, { ...ui, dependsOn: [] }, join3] });
    expect((await f.run([])).err).toContain("baseTask must name one of them");
    await f.writePlan({
      issues: [api, { ...ui, dependsOn: [] }, { ...join3, baseTask: "ui" }],
    });
    expect((await f.run([])).err).toContain("does not build on api");

    await f.writePlan();
    await f.run(["--prepare"]);
    await f.writePlan({
      issues: [{ ...api, instruction: "Build something else" }, ui],
    });
    expect((await f.run([])).err).toContain("changed since it was prepared");
    expect((await f.run([], { CODEX_THREAD_ID: "" })).err).toContain(
      "CODEX_THREAD_ID",
    );
  });

  test("does not overwrite a branch it did not create", async () => {
    const f = await fixture();
    git(f.repo, "branch", "harnexus/demo/api");
    const refused = await f.run(["--prepare"]);
    expect(refused.err).toContain("already exists");
  });
});
