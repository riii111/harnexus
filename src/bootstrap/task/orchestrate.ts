import { createHash } from "node:crypto";
import { join } from "node:path";
import { Result } from "better-result";
import {
  isDirectory,
  pathExists,
  prepareDirectory,
  realPathOrSelf,
  writeFileAtomic,
} from "../../runtime/fs.boundary.ts";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import { acquire, claudeSession, release } from "./cloud.ts";
import { type Fields, fail, jsonEqual, type TaskFailed } from "./format.ts";
import { loadPlan, type Plan } from "./orchestrate-plan.ts";
import {
  callerId,
  type Env,
  type GitRunner,
  gitIn,
  ioFailed,
  readJson,
  readText,
  singleLine,
} from "./request.ts";
import { load, type SaveJson, stateRoot } from "./session.ts";

export type OrchestrateArgs = {
  request: string;
  prepare: boolean;
  work?: string;
  candidate?: string;
  review?: string;
  reviewFile?: string;
  publish?: string;
  bodyFile?: string;
  promptFile?: string;
  model?: string;
  permissionMode?: string;
  recover?: string;
};

export type OrchestrateDeps = {
  env: Env;
  runGit: GitRunner;
  saveJson: SaveJson;
  cwd?: string;
};

type Review = {
  reviewerId: string;
  base: string;
  head: string;
  verdict: "lgtm" | "changes_requested";
  findings: unknown[];
  recordedAt: string;
};

type IssueState = {
  branch: string;
  worktree: string;
  // Where the branch was cut: the base ref, or the approved head of the task it builds on.
  start: string;
  // The branch a pull request targets instead of the base ref.
  parent: string | null;
  candidate?: { base: string; head: string; test: string[]; at: string };
  lastTest?: { head: string; ok: boolean; tail: string };
  // The first reviewer to answer; every later review goes to it.
  reviewer?: string;
  reviews: Review[];
  publish?: { head: string; prUrl: string };
};

type State = {
  planId: string;
  fingerprint: string;
  repository: string;
  baseSha: string;
  issues: Record<string, IssueState>;
};

type Ctx = {
  deps: OrchestrateDeps;
  plan: Plan;
  dir: string;
  statePath: string;
  key: string;
};

type Done = Result<Fields, TaskFailed>;

const HEX40 = /^[0-9a-f]{40}$/;
const TEST_TIMEOUT_MS = 30 * 60_000;
const NETWORK_TIMEOUT_MS = 2 * 60_000;
const PR_URL = /https:\/\/\S+\/pull\/[1-9][0-9]*/;

const io = <T>(
  pending: Promise<Result<T, { message: string; cause?: unknown }>>,
) => pending.then((done) => done.mapError(ioFailed));

const approvedHead = (issue: IssueState | undefined) => {
  const candidate = issue?.candidate;
  if (issue === undefined || candidate === undefined) return null;
  return issue.reviews.some(
    (review) => review.head === candidate.head && review.verdict === "lgtm",
  )
    ? candidate.head
    : null;
};

const sessionOf = (ctx: Ctx, id: string) => `orch/${ctx.key}/${id}`;

const workerOf = async (ctx: Ctx, id: string) => {
  const found = await claudeSession(
    { mode: "state", session: sessionOf(ctx, id) },
    { env: ctx.deps.env, saveJson: ctx.deps.saveJson },
  );
  const record = found.isOk() ? found.value : {};
  return {
    session: sessionOf(ctx, id),
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
    pending: isObject(record.pending),
  };
};

const loadState = (ctx: Ctx) =>
  Result.gen(async function* () {
    const loaded = yield* Result.await(load(ctx.statePath));
    if (loaded === null) return Result.ok<State | null>(null);
    if (!isObject(loaded) || !isObject(loaded.issues))
      return fail(`${ctx.statePath} is not an orchestration state`);
    if (loaded.fingerprint !== ctx.plan.fingerprint)
      return fail(
        `plan ${ctx.plan.planId} changed since it was prepared; keep the plan, or use a new planId (state: ${ctx.statePath})`,
      );
    return Result.ok<State | null>(loaded as State);
  });

const saveState = (ctx: Ctx, state: State) =>
  ctx.deps.saveJson(ctx.statePath, state, { exclusive: false });

// Held from the first check to the saved state, and failing at once instead of waiting.
const locked = (ctx: Ctx, name: string, run: () => Promise<Done>) =>
  Result.gen(async function* () {
    const dir = join(ctx.dir, "locks");
    yield* Result.await(io(prepareDirectory(dir)));
    const lock = join(dir, `${name}.json`);
    const token = yield* Result.await(acquire(lock));
    const done = await run();
    await release(lock, token);
    return done;
  });

const stateOf = async (ctx: Ctx) => {
  const state = await loadState(ctx);
  if (state.isOk() && state.value === null)
    return fail(`plan ${ctx.plan.planId} is not prepared; run --prepare`);
  return state.map((found) => found as State);
};

const issueOf = (ctx: Ctx, state: State, id: string) => {
  if (!ctx.plan.issues.some((issue) => issue.id === id))
    return fail(`${id} is not an issue of plan ${ctx.plan.planId}`);
  const found = state.issues[id];
  return found === undefined
    ? fail(`${id} is not prepared yet; dependencies must be approved first`)
    : Result.ok(found);
};

const dependentsPrepared = (ctx: Ctx, state: State, id: string) =>
  ctx.plan.issues.filter(
    (issue) => issue.baseTask === id && state.issues[issue.id] !== undefined,
  );

type GitOf = ReturnType<typeof gitIn>;

const gitFor = (ctx: Ctx): GitOf => gitIn(ctx.deps.runGit, ctx.deps.env);

const tidy = async (git: GitOf, issue: IssueState) => {
  const branch = await git(issue.worktree, "symbolic-ref", "-q", "HEAD");
  if (branch.isErr() || branch.value !== `refs/heads/${issue.branch}`)
    return fail(`${issue.worktree} is not on branch ${issue.branch}`);
  const dirty = await git(
    issue.worktree,
    "status",
    "--porcelain",
    "--untracked-files=all",
  );
  if (dirty.isErr()) return Result.err(dirty.error);
  if (dirty.value !== "")
    return fail(`${issue.worktree} has uncommitted changes; commit them`);
  return git(issue.worktree, "rev-parse", "HEAD");
};

const resolveBase = async (git: GitOf, plan: Plan) => {
  for (const ref of [
    `refs/heads/${plan.baseRef}`,
    `refs/remotes/origin/${plan.baseRef}`,
  ]) {
    const found = await git(
      plan.repository,
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    );
    if (found.isOk()) return found;
  }
  return fail(`baseRef ${plan.baseRef} is not a local or origin branch`);
};

// An existing worktree is only reused; a branch or path that is not this task's is never overwritten.
const ensureWorktree = (ctx: Ctx, issue: IssueState) =>
  Result.gen(async function* () {
    const git = gitFor(ctx);
    const repository = ctx.plan.repository;
    if (await isDirectory(issue.worktree)) {
      const top = yield* Result.await(
        git(issue.worktree, "rev-parse", "--show-toplevel"),
      );
      if (top !== (await realPathOrSelf(issue.worktree)))
        return fail(`${issue.worktree} is not a worktree checkout`);
      const branch = yield* Result.await(
        git(issue.worktree, "symbolic-ref", "-q", "HEAD"),
      );
      if (branch !== `refs/heads/${issue.branch}`)
        return fail(`${issue.worktree} is not on branch ${issue.branch}`);
      return Result.ok(false);
    }
    if (await pathExists(issue.worktree))
      return fail(`${issue.worktree} exists and is not a directory`);
    const existing = await git(
      repository,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${issue.branch}`,
    );
    if (existing.isOk() && existing.value !== issue.start)
      return fail(
        `branch ${issue.branch} exists at ${existing.value}, not at the start ${issue.start}`,
      );
    yield* Result.await(
      existing.isOk()
        ? git(repository, "worktree", "add", issue.worktree, issue.branch)
        : git(
            repository,
            "worktree",
            "add",
            "-b",
            issue.branch,
            issue.worktree,
            issue.start,
          ),
    );
    return Result.ok(true);
  });

const prepare = (ctx: Ctx): Promise<Done> =>
  locked(ctx, "state", () =>
    Result.gen(async function* () {
      const git = gitFor(ctx);
      const { plan } = ctx;
      const top = yield* Result.await(
        git(plan.repository, "rev-parse", "--show-toplevel"),
      );
      if (top !== (await realPathOrSelf(plan.repository)))
        return fail(`${plan.repository} is not the top level of a repository`);
      const state: State = (yield* Result.await(loadState(ctx))) ?? {
        planId: plan.planId,
        fingerprint: plan.fingerprint,
        repository: plan.repository,
        baseSha: yield* Result.await(resolveBase(git, plan)),
        issues: {},
      };
      const created: string[] = [];
      const reused: string[] = [];
      const waiting: string[] = [];
      for (const id of plan.order) {
        const issue = plan.issues.find((one) => one.id === id);
        if (issue === undefined) continue;
        const recorded = state.issues[id];
        if (recorded !== undefined) {
          const made = yield* Result.await(ensureWorktree(ctx, recorded));
          (made ? created : reused).push(id);
          continue;
        }
        const parent =
          issue.baseTask === null ? undefined : state.issues[issue.baseTask];
        const heads = issue.dependsOn.map((dep) =>
          approvedHead(state.issues[dep]),
        );
        if (heads.includes(null)) {
          waiting.push(id);
          continue;
        }
        const start =
          issue.baseTask === null ? state.baseSha : approvedHead(parent);
        if (start === null || start === undefined) {
          waiting.push(id);
          continue;
        }
        for (const head of heads) {
          const inside = await git(
            plan.repository,
            "merge-base",
            "--is-ancestor",
            String(head),
            start,
          );
          if (inside.isErr())
            return fail(
              `${id}: the work of a dependency (${head}) is not in ${issue.baseTask}, so it would be missing`,
            );
        }
        const branch = `harnexus/${plan.planId}/${id}`;
        const worktree = join(ctx.dir, "worktrees", id);
        if (
          (
            await git(
              plan.repository,
              "rev-parse",
              "--verify",
              "--quiet",
              `refs/heads/${branch}`,
            )
          ).isOk() ||
          (await pathExists(worktree))
        )
          return fail(
            `${id}: branch ${branch} or path ${worktree} already exists and is not part of this plan's state`,
          );
        state.issues[id] = {
          branch,
          worktree,
          start,
          parent: parent === undefined ? null : parent.branch,
          reviews: [],
        };
        // Recorded before creating, so a run that dies in between reuses what it made.
        yield* Result.await(saveState(ctx, state));
        yield* Result.await(
          ensureWorktree(ctx, state.issues[id] as IssueState),
        );
        created.push(id);
      }
      yield* Result.await(saveState(ctx, state));
      return Result.ok<Fields>({ created, reused, waiting });
    }),
  );

const startPrompt = (ctx: Ctx, id: string, issue: IssueState) => {
  const spec = ctx.plan.issues.find((one) => one.id === id);
  return [
    spec?.instruction.trimEnd(),
    "",
    "---",
    `Work only in ${issue.worktree} on branch ${issue.branch}.`,
    "Commit your finished work there and leave the tree clean.",
    "Do not push, open pull requests or switch branches.",
    `This command will test the commit: ${JSON.stringify(spec?.test)}`,
    "",
  ].join("\n");
};

const work = (ctx: Ctx, id: string, args: OrchestrateArgs): Promise<Done> =>
  locked(ctx, `issue-${id}`, () =>
    Result.gen(async function* () {
      const state = yield* Result.await(stateOf(ctx));
      const issue = yield* issueOf(ctx, state, id);
      if (issue.publish !== undefined || approvedHead(issue) !== null)
        return fail(`${id} is approved; there is nothing left for its worker`);
      const later = dependentsPrepared(ctx, state, id);
      if (later.length > 0)
        return fail(
          `${later.map((one) => one.id).join(", ")} already builds on ${id}'s approved head`,
        );
      const worker = await workerOf(ctx, id);
      const adopting = worker.pending && args.recover === "adopt";
      const started = worker.sessionId !== null || adopting;
      let promptFile = args.promptFile;
      if (!started && promptFile !== undefined)
        return fail(
          `${id} has no worker yet, and its first turn is the plan's instruction; --prompt-file is for a started worker`,
        );
      if (!started) {
        const git = gitFor(ctx);
        const head = yield* Result.await(tidy(git, issue));
        if (head !== issue.start)
          return fail(
            `${issue.worktree} moved from its start before the worker began`,
          );
      }
      if (promptFile === undefined) {
        if (worker.sessionId !== null)
          return fail(
            `${id} already has worker ${worker.session}; pass --prompt-file with the correction, since the task is never sent twice`,
          );
        promptFile = join(ctx.dir, "prompts", `${id}.md`);
        yield* Result.await(io(prepareDirectory(join(ctx.dir, "prompts"))));
        yield* Result.await(
          io(writeFileAtomic(promptFile, startPrompt(ctx, id, issue))),
        );
      }
      const given = {
        mode: started ? ("resume" as const) : ("start" as const),
        session: worker.session,
        promptFile,
        cwd: issue.worktree,
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.permissionMode === undefined
          ? {}
          : { permissionMode: args.permissionMode }),
        ...(args.recover === undefined ? {} : { recover: args.recover }),
      };
      const turn = yield* Result.await(
        claudeSession(given, {
          env: ctx.deps.env,
          saveJson: ctx.deps.saveJson,
        }),
      );
      return Result.ok<Fields>({
        id,
        resumed: started,
        sessionId: turn.sessionId,
        result: turn.result,
      });
    }),
  );

const tail = (text: string) => text.trim().slice(-2000);

const candidate = (ctx: Ctx, id: string): Promise<Done> =>
  locked(ctx, `issue-${id}`, () =>
    Result.gen(async function* () {
      const state = yield* Result.await(stateOf(ctx));
      const issue = yield* issueOf(ctx, state, id);
      const spec = ctx.plan.issues.find((one) => one.id === id);
      if (spec === undefined) return fail(`${id} is not in the plan`);
      const git = gitFor(ctx);
      const head = yield* Result.await(tidy(git, issue));
      if (issue.candidate?.head === head)
        return Result.ok<Fields>({
          id,
          base: issue.start,
          head,
          recorded: false,
        });
      if (issue.publish !== undefined || approvedHead(issue) !== null)
        return fail(`${id} is approved; its head can no longer change`);
      const later = dependentsPrepared(ctx, state, id);
      if (later.length > 0)
        return fail(
          `${later.map((one) => one.id).join(", ")} already builds on ${id}'s approved head`,
        );
      if (head === issue.start)
        return fail(`${id} has no commit beyond its start ${issue.start}`);
      const ran = await ctx.deps.runGit(spec.test, ctx.deps.env, {
        cwd: issue.worktree,
        timeoutMs: TEST_TIMEOUT_MS,
      });
      const after = await tidy(git, issue);
      const ok = ran.isOk() && ran.value.status === 0;
      const output = ran.isOk()
        ? tail(`${ran.value.stdout}\n${ran.value.stderr}`)
        : ran.error.message;
      if (after.isErr() || after.value !== head)
        return fail(
          `${id}'s head changed while the tests ran; run --candidate again`,
        );
      yield* Result.await(
        locked(ctx, "state", () =>
          Result.gen(async function* () {
            const now = yield* Result.await(stateOf(ctx));
            const mine = yield* issueOf(ctx, now, id);
            mine.lastTest = { head, ok, tail: ok ? "" : output };
            if (ok)
              mine.candidate = {
                base: issue.start,
                head,
                test: spec.test,
                at: new Date().toISOString(),
              };
            yield* Result.await(saveState(ctx, now));
            return Result.ok<Fields>({});
          }),
        ),
      );
      if (!ok) return fail(`the tests failed for ${head} of ${id}: ${output}`);
      return Result.ok<Fields>({ id, base: issue.start, head, recorded: true });
    }),
  );

const reviewOf = (raw: unknown) => {
  if (!isObject(raw)) return fail("the review file must be a JSON object");
  const unknown = Object.keys(raw).filter(
    (key) =>
      !["reviewerId", "base", "head", "verdict", "findings"].includes(key),
  );
  if (unknown.length > 0)
    return fail(`unknown review fields: ${unknown.sort().join(", ")}`);
  const verdict = raw.verdict;
  if (verdict !== "lgtm" && verdict !== "changes_requested")
    return fail("verdict must be lgtm or changes_requested");
  const findings = raw.findings ?? [];
  if (!Array.isArray(findings)) return fail("findings must be a list");
  if (verdict === "changes_requested" && findings.length === 0)
    return fail("changes_requested needs the findings the worker must fix");
  for (const key of ["base", "head"])
    if (typeof raw[key] !== "string" || !HEX40.test(raw[key]))
      return fail(`${key} must be a full 40-hex commit`);
  const reviewerId = singleLine(raw.reviewerId, "reviewerId");
  if (reviewerId.isErr()) return Result.err(reviewerId.error);
  return Result.ok<Omit<Review, "recordedAt">>({
    reviewerId: reviewerId.value,
    base: String(raw.base),
    head: String(raw.head),
    verdict,
    findings,
  });
};

const review = (ctx: Ctx, id: string, file: string): Promise<Done> =>
  locked(ctx, "state", () =>
    Result.gen(async function* () {
      const given = yield* reviewOf(yield* Result.await(readJson(file)));
      const state = yield* Result.await(stateOf(ctx));
      const issue = yield* issueOf(ctx, state, id);
      const current = issue.candidate;
      if (current === undefined)
        return fail(`${id} has no tested candidate to review`);
      if (given.head !== current.head || given.base !== current.base)
        return fail(
          `the review is for ${given.base}..${given.head}, but the candidate of ${id} is ${current.base}..${current.head}; review the current head`,
        );
      if (issue.reviewer !== undefined && issue.reviewer !== given.reviewerId)
        return fail(
          `${id} is reviewed by ${issue.reviewer}; send the head to that reviewer, not ${given.reviewerId}`,
        );
      if ((await workerOf(ctx, id)).sessionId === given.reviewerId)
        return fail("the reviewer must not be the worker");
      const same = issue.reviews.find((one) => one.head === given.head);
      if (same !== undefined) {
        if (
          same.reviewerId === given.reviewerId &&
          same.verdict === given.verdict &&
          jsonEqual(same.findings, given.findings)
        )
          return Result.ok<Fields>({
            id,
            verdict: same.verdict,
            recorded: false,
          });
        return fail(
          `${given.head} of ${id} already has a ${same.verdict} review; a different result needs a new head`,
        );
      }
      issue.reviews.push({
        ...given,
        recordedAt: new Date().toISOString(),
      });
      issue.reviewer ??= given.reviewerId;
      yield* Result.await(saveState(ctx, state));
      return Result.ok<Fields>({ id, verdict: given.verdict, recorded: true });
    }),
  );

type Pr = {
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefOid: string;
};

const pulls = (ctx: Ctx, issue: IssueState) =>
  (async (): Promise<Result<Pr[], TaskFailed>> => {
    const ran = await ctx.deps.runGit(
      [
        "gh",
        "pr",
        "list",
        "--head",
        issue.branch,
        "--state",
        "all",
        "--json",
        "url,state,isDraft,baseRefName,headRefOid",
      ],
      { ...ctx.deps.env, GH_PROMPT_DISABLED: "1" },
      { cwd: issue.worktree, timeoutMs: NETWORK_TIMEOUT_MS },
    );
    if (ran.isErr() || ran.value.status !== 0)
      return fail(
        `cannot read the pull requests of ${issue.branch} from GitHub (${ran.isErr() ? ran.error.message : ran.value.stderr.trim()})`,
      );
    const parsed = parseJson(ran.value.stdout);
    if (parsed.isErr() || !Array.isArray(parsed.value))
      return fail("gh pr list did not answer a list");
    return Result.ok(parsed.value as Pr[]);
  })();

const publish = (
  ctx: Ctx,
  id: string,
  bodyFile: string | undefined,
): Promise<Done> =>
  locked(ctx, `issue-${id}`, () =>
    Result.gen(async function* () {
      const state = yield* Result.await(stateOf(ctx));
      const issue = yield* issueOf(ctx, state, id);
      const spec = ctx.plan.issues.find((one) => one.id === id);
      if (spec === undefined) return fail(`${id} is not in the plan`);
      if (issue.publish !== undefined)
        return Result.ok<Fields>({
          id,
          prUrl: issue.publish.prUrl,
          recorded: false,
        });
      const head = approvedHead(issue);
      if (head === null)
        return fail(
          `${id} needs an independent LGTM on its tested head before it is published`,
        );
      const unpublished = spec.dependsOn.filter(
        (dep) => state.issues[dep]?.publish === undefined,
      );
      if (unpublished.length > 0)
        return fail(
          `publish ${unpublished.join(", ")} first; ${id} builds on it`,
        );
      const git = gitFor(ctx);
      const now = yield* Result.await(tidy(git, issue));
      if (now !== head)
        return fail(`${issue.worktree} is at ${now}, not the approved ${head}`);
      const base = issue.parent ?? ctx.plan.baseRef;
      const body =
        bodyFile === undefined
          ? spec.body
          : yield* Result.await(readText(bodyFile));
      const bodyPath = join(ctx.dir, "bodies", `${id}.md`);
      yield* Result.await(io(prepareDirectory(join(ctx.dir, "bodies"))));
      yield* Result.await(io(writeFileAtomic(bodyPath, body)));
      const done = (pr: Pr) =>
        Result.gen(async function* () {
          yield* Result.await(
            locked(ctx, "state", () =>
              Result.gen(async function* () {
                const fresh = yield* Result.await(stateOf(ctx));
                const mine = yield* issueOf(ctx, fresh, id);
                mine.publish = { head, prUrl: pr.url };
                yield* Result.await(saveState(ctx, fresh));
                return Result.ok<Fields>({});
              }),
            ),
          );
          return Result.ok<Fields>({
            id,
            prUrl: pr.url,
            isDraft: pr.isDraft,
            recorded: true,
          });
        });
      // A pull request GitHub already has for the branch is adopted when it is this head, and otherwise reported.
      const matching = (found: Pr[]): Result<Pr | null, TaskFailed> => {
        const [pr] = found;
        if (pr === undefined) return Result.ok(null);
        if (
          pr.state !== "OPEN" ||
          pr.headRefOid !== head ||
          pr.baseRefName !== base
        )
          return fail(
            `${pr.url} already exists for ${issue.branch} (${pr.state}, base ${pr.baseRefName}, head ${pr.headRefOid}); not creating another`,
          );
        return Result.ok(pr);
      };
      const existing = yield* Result.await(
        pulls(ctx, issue).then((found) => found.andThen(matching)),
      );
      if (existing !== null) return await done(existing);
      const net = { ...ctx.deps.env, GIT_TERMINAL_PROMPT: "0" };
      const gitNet = (...args: string[]) =>
        ctx.deps.runGit(
          [
            "git",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            issue.worktree,
            ...args,
          ],
          net,
          { timeoutMs: NETWORK_TIMEOUT_MS },
        );
      const listed = await gitNet(
        "ls-remote",
        "origin",
        `refs/heads/${issue.branch}`,
      );
      if (listed.isErr() || listed.value.status !== 0)
        return fail(
          `cannot read origin (${listed.isErr() ? listed.error.message : listed.value.stderr.trim()}); nothing was pushed`,
        );
      const remote = listed.value.stdout.split(/\s/)[0] ?? "";
      if (remote !== head) {
        if (remote !== "") {
          const inside = await git(
            issue.worktree,
            "merge-base",
            "--is-ancestor",
            remote,
            head,
          );
          if (inside.isErr())
            return fail(
              `origin has ${issue.branch} at ${remote}, which is not in ${head}; it is never overwritten`,
            );
        }
        const pushed = await gitNet(
          "push",
          "origin",
          `${head}:refs/heads/${issue.branch}`,
        );
        if (pushed.isErr() || pushed.value.status !== 0)
          return fail(
            `push of ${issue.branch} is not confirmed (${pushed.isErr() ? pushed.error.message : pushed.value.stderr.trim()}); run --publish again, which checks origin first`,
          );
      }
      const created = await ctx.deps.runGit(
        [
          "gh",
          "pr",
          "create",
          "--draft",
          "--base",
          base,
          "--head",
          issue.branch,
          "--title",
          spec.title,
          "--body-file",
          bodyPath,
        ],
        { ...ctx.deps.env, GH_PROMPT_DISABLED: "1" },
        { cwd: issue.worktree, timeoutMs: NETWORK_TIMEOUT_MS },
      );
      const url =
        created.isOk() && created.value.status === 0
          ? PR_URL.exec(created.value.stdout)?.[0]
          : undefined;
      if (url !== undefined)
        return await done({
          url,
          state: "OPEN",
          isDraft: true,
          baseRefName: base,
          headRefOid: head,
        });
      // The outcome is unknown, so GitHub decides whether the PR exists; creation is never repeated here.
      const after = yield* Result.await(
        pulls(ctx, issue).then((found) => found.andThen(matching)),
      );
      if (after !== null) return await done(after);
      return fail(
        `gh pr create did not confirm a pull request (${created.isErr() ? created.error.message : created.value.stderr.trim()}); ${issue.branch} is pushed, run --publish again`,
      );
    }),
  );

const view = async (
  ctx: Ctx,
  state: State | null,
  action: Fields | null,
): Promise<Fields> => {
  const issues: Fields[] = [];
  for (const spec of ctx.plan.issues) {
    const issue = state?.issues[spec.id];
    const lastReview = issue?.reviews.at(-1);
    const reviewed = issue?.reviews.find(
      (one) => one.head === issue.candidate?.head,
    );
    const approved = approvedHead(issue) !== null;
    let status: string;
    let next: string | null;
    if (issue?.publish !== undefined) [status, next] = ["published", null];
    else if (approved) [status, next] = ["approved", "publish"];
    else if (reviewed?.verdict === "changes_requested")
      [status, next] = ["changes_requested", "work"];
    else if (issue?.candidate !== undefined)
      [status, next] = ["candidate", "review"];
    else if (issue !== undefined) [status, next] = ["in_progress", "work"];
    else if (
      spec.dependsOn.every((dep) => approvedHead(state?.issues[dep]) !== null)
    )
      [status, next] = ["unprepared", "prepare"];
    else [status, next] = ["blocked", "wait"];
    const worker = issue === undefined ? null : await workerOf(ctx, spec.id);
    if (status === "in_progress" && worker?.sessionId != null)
      next = issue?.lastTest?.ok === false ? "work" : "candidate";
    issues.push({
      id: spec.id,
      status,
      next,
      dependsOn: spec.dependsOn,
      branch: issue?.branch ?? null,
      worktree: issue?.worktree ?? null,
      base: issue?.start ?? null,
      head: issue?.candidate?.head ?? null,
      reviewerId: issue?.reviewer ?? null,
      worker:
        worker === null
          ? null
          : {
              session: worker.session,
              started: worker.sessionId !== null,
              pending: worker.pending,
            },
      lastReview:
        lastReview === undefined
          ? null
          : {
              verdict: lastReview.verdict,
              head: lastReview.head,
              findings: lastReview.findings,
            },
      lastTest: issue?.lastTest ?? null,
      prUrl: issue?.publish?.prUrl ?? null,
    });
  }
  return {
    planId: ctx.plan.planId,
    state: ctx.statePath,
    baseRef: ctx.plan.baseRef,
    baseSha: state?.baseSha ?? null,
    issues,
    runnable: issues
      .filter((one) => one.next !== "wait" && one.next !== null)
      .map((one) => one.id),
    action,
  };
};

export const orchestrate = (args: OrchestrateArgs, deps: OrchestrateDeps) =>
  Result.gen(async function* () {
    const thread = yield* callerId(deps.env);
    const plan = yield* Result.await(loadPlan(args.request));
    const key = createHash("sha256")
      .update([thread, plan.planId, plan.repository].join("\n"))
      .digest("hex")
      .slice(0, 16);
    const dir = join(stateRoot(deps.env), "orchestration", key);
    const ctx: Ctx = {
      deps,
      plan,
      dir,
      statePath: join(dir, "state.json"),
      key,
    };
    let action: Fields | null = null;
    if (args.prepare) action = yield* Result.await(prepare(ctx));
    if (args.work !== undefined)
      action = yield* Result.await(work(ctx, args.work, args));
    if (args.candidate !== undefined)
      action = yield* Result.await(candidate(ctx, args.candidate));
    if (args.review !== undefined)
      action = yield* Result.await(
        review(ctx, args.review, args.reviewFile ?? ""),
      );
    if (args.publish !== undefined)
      action = yield* Result.await(publish(ctx, args.publish, args.bodyFile));
    const state = yield* Result.await(loadState(ctx));
    return Result.ok(await view(ctx, state, action));
  });
