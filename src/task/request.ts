import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Result } from "better-result";
import {
  isDirectory,
  pathExists,
  readRegularTextFile,
  realPathOrSelf,
} from "../runtime/fs.boundary.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { type Fields, isObject } from "../runtime/object.ts";
import type {
  CommandFailed,
  CommandOutput,
} from "../runtime/process.boundary.ts";
import {
  fail,
  hasSpace,
  isBlank,
  jsonEqual,
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

const COMPLETION_TARGETS = ["implementation", "draft_pr", "merge"];

export const homeOf = (env: Env) => env.HOME ?? homedir();

// A relative directory is ignored, as the XDG spec has it, so the working directory never picks the templates or the state.
export const absoluteOr = (value: string | undefined, fallback: string) =>
  value?.startsWith("/") ? value : fallback;

export const codexHome = (env: Env) =>
  absoluteOr(env.CODEX_HOME, join(homeOf(env), ".codex"));

export const configHome = (env: Env) =>
  join(
    absoluteOr(env.XDG_CONFIG_HOME, join(homeOf(env), ".config")),
    "harnexus",
  );

const ioFailed = (error: { message: string; cause?: unknown }) => {
  const { cause } = error;
  const code =
    isObject(cause) && typeof cause.code === "string" ? cause.code : null;
  return new TaskFailed({
    message: code === null ? error.message : `${error.message} (${code})`,
  });
};

export const io = async <T>(
  pending: Promise<Result<T, { message: string; cause?: unknown }>>,
): Promise<Result<T, TaskFailed>> => (await pending).mapError(ioFailed);

export const readText = (path: string) => io(readRegularTextFile(path));

export const readJson = (path: string) =>
  Result.gen(async function* () {
    const text = yield* Result.await(readText(path));
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

// The ID is pasted into worker and reviewer prompts, so it may not carry spaces or prose.
const taskId = (value: unknown) =>
  singleLine(value, "taskId").andThen((id) =>
    /^[\p{L}\p{N}_#][\p{L}\p{N}_.#/:-]*$/u.test(id)
      ? Result.ok(id)
      : fail(
          "taskId must start with a letter, digit, _ or # and contain only letters, digits and _ . # / : -",
        ),
  );

// Only the thread title shows the name, so it may carry any single-line text.
const displayName = (value: unknown) =>
  value === undefined || value === null
    ? Result.ok(null)
    : singleLine(value, "displayName");

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
  return (
    scheme?.[1]?.toLowerCase() === "https" &&
    scheme[2] !== "" &&
    !hasSpace(value)
  );
};

const documentRefs = (values: unknown) =>
  Result.gen(async function* () {
    if (!Array.isArray(values) || values.length === 0)
      return fail("documentRefs must be a nonempty list of paths or URLs");
    for (const value of values) {
      const ref = yield* singleLine(value, "documentRefs entry");
      if (isHttpsUrl(ref)) continue;
      if (!ref.startsWith("/") || !(await pathExists(ref)))
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
        ["startingBranch", "displayName"],
      ),
    );
    yield* taskId(data.taskId);
    yield* displayName(data.displayName);
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
    if (typeof target !== "string" || !COMPLETION_TARGETS.includes(target))
      return fail(
        "completionTarget must be implementation, draft_pr, or merge",
      );
    return Result.ok(data);
  });

export const workerFields = (data: Fields) =>
  Result.gen(async function* () {
    return Result.ok<Record<string, string>>({
      task_id: String(data.taskId),
      document_refs: yield* Result.await(documentRefs(data.documentRefs)),
      completion_target: String(data.completionTarget),
    });
  });

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

// A Claude Code cloud session works in its own checkout, so there the checkout only has to be the top level of a repository.
export const reviewRequest = (
  path: string,
  env: Env,
  git: Git,
  { anyCheckout = false }: { anyCheckout?: boolean } = {},
) =>
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
        ["prUrl", "workerChatId", "displayName"],
      ),
    );
    yield* taskId(data.taskId);
    yield* displayName(data.displayName);
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
    const checkout = await realPathOrSelf(requested);
    const worktrees = await realPathOrSelf(join(codexHome(env), "worktrees"));
    const refused = fail(
      anyCheckout
        ? "checkout must be the absolute path of a repository's top level"
        : `checkout must be the top level of a worker worktree ${worktrees}/<id>/<name>`,
    );
    if (
      !requested.startsWith("/") ||
      (!anyCheckout && dirname(dirname(checkout)) !== worktrees) ||
      !(await isDirectory(checkout))
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

export const sessionValue = async (data: Fields, key: string) => {
  const value = data[key];
  return key === "checkout" && truthy(value)
    ? realPathOrSelf(String(value))
    : (value ?? null);
};

// replyTo names how the reviewer returns its result: the worker's chat in the app, or, in a Claude Code cloud session, the run's own answer.
export const reviewFields = (
  data: Fields,
  replyTo: string = String(data.workerAI),
) =>
  Result.gen(async function* () {
    return Result.ok<Record<string, string>>({
      task_id: String(data.taskId),
      document_refs: yield* Result.await(documentRefs(data.documentRefs)),
      worker_ai: String(data.workerAI),
      reply_to: replyTo,
      worker_chat_id: String(data.workerChatId),
      checkout: String(data.checkout),
      pr_url: truthy(data.prUrl) ? String(data.prUrl) : "null",
      base: String(data.base),
      head: String(data.head),
    });
  });
