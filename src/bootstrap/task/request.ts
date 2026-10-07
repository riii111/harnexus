import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Result } from "better-result";
import {
  pathKind,
  readRegularTextFile,
  resolvePathLoosely,
} from "../../runtime/fs.boundary.ts";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import type {
  CommandFailed,
  CommandOutput,
} from "../../runtime/process.boundary.ts";
import {
  type Fields,
  fail,
  hasSpace,
  isBlank,
  jsonEqual,
  pyFormat,
  SPACE_CHARS,
  TaskFailed,
  truthy,
} from "./format.ts";

export const NAME = "harnexus-task";

export type Env = Record<string, string | undefined>;

export type GitRunner = (
  argv: readonly string[],
  env: Env,
) => Promise<Result<CommandOutput, CommandFailed>>;

const COMPLETION_TARGETS: Record<string, string> = {
  implementation: "実装・検証まで",
  draft_pr: "Draft PR・CI成功まで",
  merge: "マージまで",
};

export const homeOf = (env: Env) => env.HOME ?? homedir();

export const codexHome = (env: Env) =>
  env.CODEX_HOME ?? join(homeOf(env), ".codex");

export const ioFailed = (error: { message: string; cause?: unknown }) => {
  const { cause } = error;
  const code =
    isObject(cause) && typeof cause.code === "string" ? cause.code : null;
  return new TaskFailed({
    message: code === null ? error.message : `${error.message} (${code})`,
  });
};

export const readJson = (path: string) =>
  Result.gen(async function* () {
    const text = yield* Result.await(
      readRegularTextFile(path).then((read) => read.mapError(ioFailed)),
    );
    return parseJson(text).mapError(
      () => new TaskFailed({ message: `${path} is not valid JSON` }),
    );
  });

const readRequest = (
  path: string,
  required: readonly string[],
  optional: readonly string[],
) =>
  Result.gen(async function* () {
    const data = yield* Result.await(readJson(path));
    if (!isObject(data)) return fail("request must be a JSON object");
    const unknown = Object.keys(data)
      .filter((key) => !required.includes(key) && !optional.includes(key))
      .sort();
    if (unknown.length > 0)
      return fail(`unknown request fields: ${unknown.join(", ")}`);
    const missing = required.filter((key) => !Object.hasOwn(data, key)).sort();
    if (missing.length > 0)
      return fail(`missing request fields: ${missing.join(", ")}`);
    return Result.ok(data);
  });

export const singleLine = (value: unknown, name: string) =>
  typeof value !== "string" ||
  isBlank(value) ||
  [...value].some((char) => (char.codePointAt(0) ?? 0) < 32)
    ? fail(`${name} must be a nonempty single-line string`)
    : Result.ok(value);

const taskId = (value: unknown) =>
  singleLine(value, "taskId").andThen((id) =>
    /^[\p{L}\p{N}_#][\p{L}\p{N}_.#/-]*$/u.test(id)
      ? Result.ok(id)
      : fail("taskId must be an identifier without prose or spaces"),
  );

export const chatId = (value: unknown, name: string) =>
  singleLine(value, name).andThen((id) =>
    hasSpace(id) || id.startsWith("client-new-thread:")
      ? fail(`${name} must be a confirmed chat ID without whitespace`)
      : Result.ok(id),
  );

export const callerId = (env: Env) => {
  const value = env.CODEX_THREAD_ID;
  if (value === undefined || value === "")
    return fail(`CODEX_THREAD_ID is not set; run ${NAME} from a thread`);
  return chatId(value, "CODEX_THREAD_ID");
};

// urlsplit's scheme and netloc, which decide whether a reference is a URL rather than a path.
const isHttpsUrl = (value: string) => {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/s.exec(value);
  if (scheme === null || scheme[1]?.toLowerCase() !== "https")
    return Result.ok(false);
  const netloc = scheme[2] ?? "";
  if (netloc.includes("[") !== netloc.includes("]"))
    return fail("Invalid IPv6 URL");
  return Result.ok(netloc !== "" && !hasSpace(value));
};

const documentRefs = (values: unknown) =>
  Result.gen(async function* () {
    if (!Array.isArray(values) || values.length === 0)
      return fail("documentRefs must be a nonempty list of paths or URLs");
    for (const value of values) {
      const ref = yield* singleLine(value, "documentRefs entry");
      if (yield* isHttpsUrl(ref)) continue;
      if (!ref.startsWith("/") || (await pathKind(ref)) === null)
        return fail(
          `document reference must be an existing absolute path or HTTPS URL: ${ref}`,
        );
    }
    if (new Set(values).size !== values.length)
      return fail("documentRefs must not contain duplicate references");
    return Result.ok(values.map((value) => `- ${value}`).join("\n"));
  });

export const launchRequest = (path: string) =>
  Result.gen(async function* () {
    const data = yield* Result.await(
      readRequest(
        path,
        ["taskId", "documentRefs", "completionTarget", "projectId"],
        ["startingBranch"],
      ),
    );
    yield* taskId(data.taskId);
    yield* singleLine(data.projectId, "projectId");
    const branch = data.startingBranch;
    if (
      branch !== undefined &&
      branch !== null &&
      (typeof branch !== "string" ||
        !/^[\p{L}\p{N}_][\p{L}\p{N}_./-]*$/u.test(branch) ||
        branch.includes("..") ||
        [".lock", "/", "."].some((end) => branch.endsWith(end)))
    )
      return fail("startingBranch must be a branch name");
    yield* Result.await(documentRefs(data.documentRefs));
    const target = data.completionTarget;
    if (
      typeof target !== "string" ||
      !Object.hasOwn(COMPLETION_TARGETS, target)
    )
      return fail(
        "completionTarget must be implementation, draft_pr, or merge",
      );
    return Result.ok(data);
  });

export const workerPrompt = (data: Fields, skills: string) =>
  Result.gen(async function* () {
    const skill = join(skills, "task-worker/SKILL.md");
    const template = join(skills, "task-session-launch/references/worker.md");
    if (
      (await pathKind(skill)) !== "file" ||
      (await pathKind(template)) !== "file"
    )
      return fail("task-worker or worker template is not installed");
    const text = yield* Result.await(readText(template));
    return pyFormat(text, {
      task_id: String(data.taskId),
      document_refs: yield* Result.await(documentRefs(data.documentRefs)),
      completion_target:
        COMPLETION_TARGETS[String(data.completionTarget)] ?? "",
      worker_skill_path: await resolvePathLoosely(skill),
    });
  });

const readText = (path: string) =>
  readRegularTextFile(path).then((read) => read.mapError(ioFailed));

// Runs unsandboxed: never let repository config start helpers or transports.
const GIT_SAFETY = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.allow=never",
];

export type Git = (
  checkout: string,
  ...args: string[]
) => Promise<Result<string, TaskFailed>>;

export const gitIn =
  (runGit: GitRunner, env: Env): Git =>
  async (checkout, ...args) => {
    const ran = await runGit(["git", ...GIT_SAFETY, "-C", checkout, ...args], {
      ...env,
      GIT_NO_LAZY_FETCH: "1",
    });
    if (ran.isErr()) return Result.err(ioFailed(ran.error));
    if (ran.value.status !== 0)
      return fail(
        `${ran.value.stderr.trim()}; ${NAME} never fetches, so fetch any missing commit in the worktree`,
      );
    return Result.ok(ran.value.stdout.trim());
  };

const PR_URL = new RegExp(
  `^https://[^/${SPACE_CHARS}]+/[^/${SPACE_CHARS}]+/[^/${SPACE_CHARS}]+/pull/[1-9][0-9]*/?$`,
  "u",
);

export const reviewRequest = (path: string, env: Env, git: Git) =>
  Result.gen(async function* () {
    const data = yield* Result.await(
      readRequest(
        path,
        [
          "taskId",
          "workerAI",
          "projectId",
          "checkout",
          "baseBranch",
          "documentRefs",
        ],
        ["prUrl", "workerChatId"],
      ),
    );
    yield* taskId(data.taskId);
    yield* Result.await(documentRefs(data.documentRefs));
    for (const key of ["projectId", "checkout", "baseBranch"]) {
      yield* singleLine(data[key], key);
    }
    if (data.workerAI !== "Claude" && data.workerAI !== "Codex")
      return fail("workerAI must be Claude or Codex");
    const prUrl = data.prUrl;
    if (
      prUrl !== undefined &&
      prUrl !== null &&
      (typeof prUrl !== "string" || !PR_URL.test(prUrl))
    )
      return fail("prUrl must be a pull request URL or null");
    if (!Object.hasOwn(data, "prUrl")) data.prUrl = null;
    const requested = String(data.checkout);
    const checkout = await resolvePathLoosely(requested);
    const worktrees = await resolvePathLoosely(
      join(codexHome(env), "worktrees"),
    );
    const refused = fail(
      `checkout must be the top level of a worker worktree ${worktrees}/<id>/<name>`,
    );
    if (
      !requested.startsWith("/") ||
      dirname(dirname(checkout)) !== worktrees ||
      (await pathKind(checkout)) !== "directory"
    )
      return refused;
    const top = yield* Result.await(
      git(checkout, "rev-parse", "--show-toplevel"),
    );
    if (top !== checkout) return refused;
    data.checkout = checkout;
    return Result.ok(data);
  });

export const candidate = (
  data: Fields,
  previous: Fields | null,
  updateBase: boolean,
  git: Git,
) =>
  Result.gen(async function* () {
    const checkout = String(data.checkout);
    data.head = yield* Result.await(git(checkout, "rev-parse", "HEAD"));
    if (truthy(previous) && previous !== null && !updateBase) {
      const branch = previous.baseBranch;
      if (
        branch !== undefined &&
        branch !== null &&
        !jsonEqual(branch, data.baseBranch)
      )
        return fail(
          "baseBranch changed; use --update-base after integrating upstream",
        );
      if (typeof previous.base !== "string")
        return fail("the recorded review candidate has no base");
      data.base = previous.base;
    } else {
      const reference = yield* Result.await(
        git(
          checkout,
          "rev-parse",
          "--symbolic-full-name",
          "--verify",
          "--end-of-options",
          String(data.baseBranch),
        ),
      );
      if (
        !reference.startsWith("refs/heads/") &&
        !reference.startsWith("refs/remotes/")
      )
        return fail("baseBranch must name a local or remote branch");
      data.base = yield* Result.await(
        git(checkout, "rev-parse", "--verify", `${reference}^{commit}`),
      );
    }
    const base = String(data.base);
    const merged = yield* Result.await(
      git(checkout, "merge-base", base, String(data.head)),
    );
    if (merged !== base) return fail("review base must be an ancestor of head");
    return Result.ok(data);
  });

// reviewctl's field names, so a session it recorded is still checked field by field.
const OLD_NAMES: Record<string, string> = {
  taskId: "identifier",
  workerAI: "worker",
  workerChatId: "workerId",
};

export const sessionValue = async (data: Fields, key: string) => {
  const old = OLD_NAMES[key];
  const value = Object.hasOwn(data, key)
    ? data[key]
    : old === undefined
      ? null
      : data[old];
  return key === "checkout" && truthy(value)
    ? resolvePathLoosely(String(value))
    : (value ?? null);
};

export const reviewPrompt = (data: Fields, skills: string) =>
  Result.gen(async function* () {
    const references = join(skills, "task-review-cycle/references");
    const paths = {
      skill_path: join(skills, "ai-code-review/SKILL.md"),
      cycle_skill_path: join(skills, "task-review-cycle/SKILL.md"),
      reply_path: join(
        references,
        `reply-${String(data.workerAI).toLowerCase()}.md`,
      ),
    };
    const template = join(references, "reviewer.md");
    for (const path of [template, ...Object.values(paths)]) {
      if ((await pathKind(path)) !== "file")
        return fail("ai-code-review or reviewer templates are not installed");
    }
    const text = yield* Result.await(readText(template));
    const resolved: Record<string, string> = {};
    for (const [key, path] of Object.entries(paths)) {
      resolved[key] = await resolvePathLoosely(path);
    }
    return pyFormat(text, {
      ...resolved,
      task_id: String(data.taskId),
      document_refs: yield* Result.await(documentRefs(data.documentRefs)),
      worker_ai: String(data.workerAI),
      worker_chat_id: String(data.workerChatId),
      checkout: String(data.checkout),
      pr_url: truthy(data.prUrl) ? String(data.prUrl) : "null",
      base: String(data.base),
      head: String(data.head),
    });
  });
