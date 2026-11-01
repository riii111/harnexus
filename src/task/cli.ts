import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import { claudeCliFile, parseCloudSessionId } from "../infra/claude/cloud.ts";
import {
  type CloudStarted,
  startCloudSession,
} from "../infra/claude/cloud-new.boundary.ts";
import type { CallOutcome } from "../infra/codex/call-gateway.ts";
import { dryRun, release, status, watchForever } from "../prwatch/commands.ts";
import { createGitHub } from "../prwatch/github.ts";
import {
  githubPr,
  linkedChat,
  loadLink,
  loadSender,
  recordLink,
  recordSender,
} from "../prwatch/store.ts";
import type { WatchPaths } from "../prwatch/watcher.ts";
import { type OptionTypes, parseOptions } from "../runtime/args.boundary.ts";
import { removeFile } from "../runtime/fs.boundary.ts";
import { type Fields, isObject } from "../runtime/object.ts";
import { runCommand } from "../runtime/process.boundary.ts";
import { cloudReview } from "./cloud-review.ts";
import {
  declaredEnvironment,
  detectEnvironment,
  refuseInCloud,
} from "./environment.ts";
import { asText, fail, isBlank, jsonEqual, truthy } from "./format.ts";
import { load, type SaveJson, saveJson, stateRoot } from "./records.ts";
import {
  callerId,
  candidate,
  chatId,
  configHome,
  type Env,
  type GitRunner,
  gitIn,
  io,
  launchRequest,
  NAME,
  readJson,
  readText,
  reviewFields,
  reviewRequest,
  sessionValue,
  singleLine,
  workerFields,
} from "./request.ts";
import {
  callApp,
  launchOfThread,
  launchSession,
  listState,
  projectsIn,
  reviewProject,
  reviewSession,
} from "./session.ts";
import { taskPrompt } from "./templates.ts";
import { programWatch } from "./watch-program.ts";
import { codexWorkers, senderFor } from "./watch-worker.ts";

export type TaskDeps = {
  env: Env;
  runGit: GitRunner;
  saveJson: SaveJson;
  // Only the watch writes as it runs, since it never returns.
  print: (line: string) => void;
  // Starts a Cloud session from a description in a folder, as claude --cloud does.
  startCloud?: (
    description: string,
    cwd: string,
    env: Env,
  ) => Promise<Result<CloudStarted, { message: string }>>;
};

export const TASK_DEPS = {
  runGit: (argv, env) => runCommand(argv[0] ?? "git", argv.slice(1), env),
  saveJson,
  print: (line) => {
    process.stdout.write(line);
  },
  startCloud: (description, cwd, env) =>
    startCloudSession(claudeCliFile(env), description, { cwd, env }),
} satisfies Omit<TaskDeps, "env">;

type LaunchArgs = {
  request: string;
  model: string | undefined;
  thinking: string | undefined;
};

type ReviewArgs = LaunchArgs & {
  updateBase: boolean;
  recover: "discard" | undefined;
  // A message for the task's reviewer, in a Claude Code cloud session.
  ask: string | undefined;
};

type StateArgs = { request: string | undefined };

type ResolveArgs = {
  request: string;
  sent: boolean;
  threadId: string | undefined;
};

type NameArgs = { pr: string };

type WatchArgs = {
  dryRun: boolean;
  prs: string[];
  release: string | undefined;
  status: boolean;
  sender: boolean;
  link: string | undefined;
};

type CloudArgs = {
  link: string | undefined;
  promptFile: string | undefined;
  project: string;
  title: string | undefined;
  model: string | undefined;
  thinking: string | undefined;
};

const worktreeTarget = (project: unknown) => ({
  type: "project",
  projectId: project,
  environment: { type: "worktree" } as Fields,
});

const threadTitle = (kind: string, data: Fields) =>
  truthy(data.displayName)
    ? `${kind}｜${asText(data.displayName)}`
    : `${kind} ${asText(data.taskId)}`;

const withoutName = ({ displayName: _, ...rest }: Fields) => rest;

const sameTask = (recorded: unknown, data: Fields) =>
  // The name is only shown, so renaming a task still finds its worker.
  isObject(recorded) && jsonEqual(withoutName(recorded), withoutName(data));

const launch = (args: LaunchArgs, deps: TaskDeps) =>
  Result.gen(async function* () {
    yield* refuseInCloud(deps.env, "launch");
    const data = yield* Result.await(launchRequest(args.request));
    const session = yield* Result.await(launchSession(data, deps));
    if (session.state !== null) {
      if (!sameTask(session.state.request, data))
        return fail(
          `${asText(data.taskId)} already has worker ${asText(session.state.threadId)} ` +
            "launched with a different request",
        );
      return Result.ok<Fields>({
        existing: session.state.threadId ?? null,
        state: session.statePath,
      });
    }
    const target = worktreeTarget(data.projectId);
    const fields = yield* Result.await(workerFields(data));
    const prompt = yield* Result.await(taskPrompt(deps.env, "worker", fields));
    const sent: Fields = {
      prompt,
      target,
      title: threadTitle("Impl", data),
      model: args.model || "claude-sonnet-5-5",
      thinking: args.thinking || "high",
    };
    if (truthy(data.startingBranch))
      target.environment.startingState = {
        type: "branch",
        branchName: data.startingBranch,
      };
    const caller = yield* callerId(deps.env);
    return await session.send(caller, "create_thread", sent, {
      request: data,
      workspace: target,
    });
  });

const review = (args: ReviewArgs, deps: TaskDeps) =>
  Result.gen(async function* () {
    const declared = yield* declaredEnvironment(deps.env);
    if (declared?.environment === "cloud" && declared.host === "claude")
      return await cloudReview(
        {
          request: args.request,
          updateBase: args.updateBase,
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.thinking === undefined ? {} : { thinking: args.thinking }),
          ...(args.recover === undefined ? {} : { recover: args.recover }),
          ...(args.ask === undefined ? {} : { ask: args.ask }),
        },
        {
          env: deps.env,
          saveJson: deps.saveJson,
          git: gitIn(deps.runGit, deps.env),
        },
      );
    yield* refuseInCloud(deps.env, "review");
    // In the app the reviewer is a chat of its own, which is asked there.
    if (args.ask !== undefined)
      return fail(
        "--ask applies to review only in a Claude Code cloud session",
      );
    if (args.recover !== undefined)
      return fail(
        "--recover applies to review only in a Claude Code cloud session",
      );
    const git = gitIn(deps.runGit, deps.env);
    let data = yield* Result.await(reviewRequest(args.request, deps.env, git));
    const worker = yield* callerId(deps.env);
    if (!Object.hasOwn(data, "workerChatId")) data.workerChatId = worker;
    if (data.workerChatId !== worker)
      return fail("workerChatId in the request must equal CODEX_THREAD_ID");
    const session = yield* Result.await(reviewSession(data, deps));
    yield* session.checkIdle();
    const recorded = session.state?.candidate ?? null;
    if (truthy(recorded) && !isObject(recorded))
      return fail(`${session.statePath} holds an invalid candidate`);
    const previous = isObject(recorded) && truthy(recorded) ? recorded : null;
    data = yield* Result.await(candidate(data, previous, args.updateBase, git));
    if (previous !== null) {
      for (const key of [
        "taskId",
        "workerAI",
        "workerChatId",
        "projectId",
        "checkout",
      ]) {
        const before = await sessionValue(previous, key);
        if (!jsonEqual(before, await sessionValue(data, key)))
          return fail(`review session must keep the original ${key}`);
      }
      if (jsonEqual(previous.head ?? null, data.head))
        return fail(
          `head ${asText(data.head)} was already sent to reviewer ` +
            `${asText(session.state?.reviewer)}; wait for its result`,
        );
    }
    const fields = yield* Result.await(reviewFields(data));
    const sent: Fields = {
      prompt: yield* Result.await(taskPrompt(deps.env, "reviewer", fields)),
    };
    let tool = "create_thread";
    if (session.state !== null) {
      tool = "send_message_to_thread";
      sent.threadId = session.state.reviewer;
      if (args.model !== undefined) sent.model = args.model;
      if (args.thinking !== undefined) sent.thinking = args.thinking;
    } else {
      const project = yield* Result.await(
        reviewProject(deps.env, String(data.workerChatId)),
      );
      Object.assign(sent, {
        target: {
          type: "project",
          projectId: project,
          environment: { type: "local" },
        },
        title: threadTitle("Review", data),
        model: args.model || "gpt-6.1-sol",
        thinking: args.thinking || "medium",
      });
    }
    return await session.send(String(data.workerChatId), tool, sent, {
      candidate: data,
      workspace: data.checkout,
    });
  });

const requestedSession = (path: string, deps: TaskDeps) =>
  Result.gen(async function* () {
    const raw = yield* Result.await(readJson(path));
    if (isObject(raw) && Object.hasOwn(raw, "completionTarget")) {
      const data = yield* Result.await(launchRequest(path));
      return await launchSession(data, deps);
    }
    const git = gitIn(deps.runGit, deps.env);
    const data = yield* Result.await(reviewRequest(path, deps.env, git));
    data.workerChatId = yield* callerId(deps.env);
    return await reviewSession(data, deps);
  });

const state = (args: StateArgs, deps: TaskDeps) =>
  Result.gen(async function* () {
    if (args.request === undefined) return await listState(deps.env);
    yield* refuseInCloud(deps.env, "state --request");
    const session = yield* Result.await(requestedSession(args.request, deps));
    return await session.show();
  });

const resolve = (args: ResolveArgs, deps: TaskDeps) =>
  Result.gen(async function* () {
    yield* refuseInCloud(deps.env, "resolve");
    const thread = args.threadId
      ? yield* chatId(args.threadId, "--thread-id")
      : null;
    const session = yield* Result.await(requestedSession(args.request, deps));
    return await session.resolve(args.sent, thread);
  });

// A PR URL may carry a tab, query or fragment after its number, as when copied from the browser.
const PR_NUMBER =
  /^(?:#?([1-9][0-9]*)|https:\/\/\S+\/pull\/([1-9][0-9]*)(?:[/?#]\S*)?)$/;

const name = (args: NameArgs, deps: TaskDeps) =>
  Result.gen(async function* () {
    yield* refuseInCloud(deps.env, "name");
    const matched = PR_NUMBER.exec(args.pr);
    const number = matched?.[1] ?? matched?.[2];
    if (number === undefined)
      return fail("--pr must be a pull request URL or number");
    const worker = yield* callerId(deps.env);
    // Linked first and for any chat, so a worker the owner started by hand is still watched.
    // A worker naming its PR takes it over, as the latest worker on a PR is the one doing it.
    const watched = yield* Result.await(linkPr(deps, args.pr, worker));
    const request = yield* Result.await(launchOfThread(deps.env, worker));
    // Only a launched worker has a title to extend; another chat keeps its own.
    // The number goes last so the title still reads as the task, while a search for the PR finds the worker.
    const title =
      request === null ? null : `${threadTitle("Impl", request)} PR#${number}`;
    const answer =
      title === null
        ? null
        : await callApp(deps.env, worker, "name_thread", { name: title });
    const renamed =
      answer === null || answer.outcome === ("done" satisfies CallOutcome);
    // Fails even after a rename, so a PR the watch cannot see is never taken as watched.
    if (watched === null)
      return fail(
        `${args.pr} is not watched${title === null || !renamed ? "" : ` (the thread is named ${title})`}: ${NOT_LINKABLE}`,
      );
    // A rename the app did not apply leaves the PR watched, which the result says rather than failing.
    return Result.ok<Fields>({
      threadId: worker,
      title: renamed ? title : null,
      watched,
      ...(renamed
        ? {}
        : {
            renameError: `name_thread was not applied: ${JSON.stringify(answer)}`,
          }),
      ...(await deliveryWarning(deps, worker)),
    });
  });

// Warns about a linked chat nothing can send to, which the link alone would show as watched.
const deliveryWarning = async (
  deps: TaskDeps,
  worker: string,
): Promise<{ warning?: string }> => {
  const sender = senderFor(
    await loadSender(watchPaths(deps.env).state),
    worker,
  );
  return typeof sender === "string" ? {} : { warning: sender.missing };
};

const NOT_LINKABLE =
  "the PR watch needs the URL https://github.com/<owner>/<repo>/pull/<number>";

// Links the PR to the worker in the watch's records.
const linkPr = (deps: TaskDeps, value: string, worker: string) =>
  Result.gen(async function* () {
    const pr = githubPr(value);
    if (pr === null) return Result.ok(null);
    const root = watchPaths(deps.env).state;
    // Only the link is read, so an unreadable state never stops a chat from naming its PR.
    const current = yield* Result.await(loadLink(root, pr));
    // The link is kept apart from the title, so the watch finds the worker of a PR without reading thread names.
    yield* Result.await(
      recordLink(root, {
        ...pr,
        worker,
        // Naming the same PR again keeps its start, so comments made since are still reported.
        linkedAt:
          current?.worker === worker
            ? current.linkedAt
            : new Date().toISOString(),
      }),
    );
    return Result.ok(pr.url);
  });

// The watch keeps its config beside harnexus's and its records beside the other task records.
export const watchPaths = (env: Env): WatchPaths => ({
  config: join(configHome(env), "pr-watch.json"),
  state: join(stateRoot(env), "watch"),
});

const watch = async (args: WatchArgs, deps: TaskDeps) => {
  const refused = refuseInCloud(deps.env, "watch");
  if (refused.isErr()) return Result.err(refused.error);
  const paths = watchPaths(deps.env);
  if (args.release !== undefined) return release(paths.state, args.release);
  if (args.status) return status(paths.state);
  if (args.sender) return registerSender(deps, paths.state);
  if (args.link !== undefined) return linkOnly(deps, args.link);
  const github = createGitHub(deps.runGit, deps.env);
  if (args.dryRun) return dryRun({ paths, github }, args.prs);
  const log = (entry: Fields) =>
    deps.print(
      `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`,
    );
  // Only a compiled harnexus-task is its own program; run from source, the program is Bun.
  const replaced = await programWatch(
    process.execPath,
    Bun.main.startsWith("/$bunfs/"),
  );
  if (replaced === null) log({ event: "replace_check_off" });
  // Said once at start, since without a registered chat no PR is ever sent to.
  const registered = await loadSender(paths.state);
  if (registered.isErr() || registered.value === null)
    log({
      event: "no_sender_registered",
      ...(registered.isErr() ? { error: registered.error.message } : {}),
    });
  return watchForever(
    {
      paths,
      github,
      workers: codexWorkers(
        (caller, tool, sent) => callApp(deps.env, caller, tool, sent),
        () => loadSender(paths.state),
      ),
      now: () => new Date(),
      log,
    },
    (ms) => Bun.sleep(ms),
    replaced ?? undefined,
  );
};

// The calling chat becomes the one the watch sends every message from.
const registerSender = (deps: TaskDeps, root: string) =>
  Result.gen(async function* () {
    const thread = yield* callerId(deps.env);
    yield* Result.await(recordSender(root, thread));
    return Result.ok<Fields>({ sender: thread });
  });

// Links the calling chat to a PR without renaming it.
const linkOnly = (deps: TaskDeps, value: string) =>
  Result.gen(async function* () {
    const worker = yield* callerId(deps.env);
    const pr = githubPr(value);
    if (pr === null) return fail(`${value} is not watched: ${NOT_LINKABLE}`);
    const current = yield* Result.await(
      linkedChat(watchPaths(deps.env).state, pr),
    );
    // A chat never takes a PR another chat is watched for.
    if (current?.active && current.worker !== worker)
      return fail(
        `${pr.url} is already watched for chat ${current.worker}; name it with name --pr from the chat that takes it over`,
      );
    const watched = yield* Result.await(linkPr(deps, value, worker));
    return Result.ok<Fields>({
      threadId: worker,
      watched,
      ...(await deliveryWarning(deps, worker)),
    });
  });

// Opens a chat that shows a Cloud session: a new Claude chat whose first message, /cloud, links it as if the user had typed it; --prompt-file first starts the session in the project's folder.
const cloud = (args: CloudArgs, deps: TaskDeps) =>
  Result.gen(async function* () {
    yield* refuseInCloud(deps.env, "cloud");
    yield* singleLine(args.project, "--project");
    const caller = yield* callerId(deps.env);
    let sessionId = parseCloudSessionId(args.link ?? "");
    let title = args.title || null;
    if (args.promptFile !== undefined) {
      const description = yield* Result.await(readText(args.promptFile));
      if (isBlank(description)) return fail("the prompt file is empty");
      const folder = yield* Result.await(
        projectFolder(deps.env, caller, args.project),
      );
      const start = deps.startCloud ?? TASK_DEPS.startCloud;
      const started = await start(description, folder, deps.env);
      if (started.isErr())
        return fail(
          `claude --cloud did not start a session: ${started.error.message}`,
        );
      sessionId = started.value.sessionId;
      title ??= started.value.title;
    }
    if (sessionId === null)
      return fail(
        "--link must be a Cloud session id or its claude.ai/code URL",
      );
    // A session already linked, such as by a /cloud typed in a chat, keeps its chat, which is answered instead of opening one /cloud would refuse; a bridge that does not know the call answers as if it were not linked.
    const linked = await callApp(deps.env, caller, "cloud_chat", { sessionId });
    const owner =
      linked.outcome === "done" && isObject(linked.result)
        ? linked.result.threadId
        : null;
    if (typeof owner === "string")
      return Result.ok<Fields>({
        threadId: owner,
        cloudSessionId: sessionId,
        url: `https://claude.ai/code/${sessionId}`,
        alreadyLinked: true,
      });
    // One chat per session, so a chat that takes its own /cloud as a request cannot open chats without end.
    const opened = join(
      stateRoot(deps.env),
      "cloud-chats",
      `${sessionId}.json`,
    );
    // Claimed before the app is asked, so two runs for one session cannot both open a chat.
    const claimed = await deps.saveJson(
      opened,
      { threadId: null, startedAt: new Date().toISOString() },
      { exclusive: true },
    );
    if (claimed.isErr()) {
      const earlier = yield* Result.await(load(opened));
      const threadId = isObject(earlier) ? earlier.threadId : null;
      return fail(
        truthy(threadId)
          ? `a chat for Cloud session ${sessionId} was already opened (threadId ${asText(threadId)}); use that chat, or remove ${opened} to open another`
          : `a chat for Cloud session ${sessionId} is being opened, or its opening did not report back; check the app, then remove ${opened} to open one`,
      );
    }
    const answer = await callApp(deps.env, caller, "create_thread", {
      prompt: `/cloud ${sessionId}`,
      target: {
        type: "project",
        projectId: args.project,
        environment: { type: "local" },
      },
      title: `☁️ ${title ?? sessionId}`,
      model: args.model || "claude-sonnet-5-5",
      thinking: args.thinking || "high",
    });
    // A session already started keeps running, so its id is named even when the chat was not opened.
    if (answer.outcome !== "done" || !truthy(answer.threadId)) {
      // Only a call the app surely did not act on frees the session for another try.
      if (UNOPENED.has(String(answer.outcome)))
        yield* Result.await(io(removeFile(opened)));
      return fail(
        `create_thread ${asText(answer.outcome)} for Cloud session ${sessionId}: ${asText(answer.error ?? answer)}`,
      );
    }
    yield* Result.await(
      deps.saveJson(
        opened,
        { threadId: answer.threadId, openedAt: new Date().toISOString() },
        { exclusive: false },
      ),
    );
    return Result.ok<Fields>({
      threadId: answer.threadId,
      cloudSessionId: sessionId,
      url: `https://claude.ai/code/${sessionId}`,
    });
  });

const UNOPENED = new Set(["not_sent", "rejected", "invalid"]);

// The folder of a project in the app.
const projectFolder = async (env: Env, caller: string, projectId: string) => {
  const answer = await callApp(env, caller, "list_projects", {});
  if (answer.outcome !== "done")
    return fail(`list_projects failed: ${JSON.stringify(answer)}`);
  for (const project of projectsIn(answer.result)) {
    if (
      isObject(project) &&
      project.projectId === projectId &&
      typeof project.path === "string"
    )
      return Result.ok(project.path);
  }
  return fail(`no project ${projectId} in the app`);
};

const environment = async (deps: TaskDeps) =>
  (await detectEnvironment(deps.env)).map((found): Fields => ({ ...found }));

type Outcome = Result<unknown, { message: string }>;

type Subcommand = {
  usage: string;
  options: OptionTypes;
  prepare: (
    values: Values,
  ) => Result<(deps: TaskDeps) => Promise<TaskRun>, UsageInvalid>;
};

type Values = Record<string, unknown>;

const subcommand = <Args>(definition: {
  usage: string;
  options: OptionTypes;
  args: (values: Values) => Result<Args, UsageInvalid>;
  run: (args: Args, deps: TaskDeps) => Outcome | Promise<Outcome>;
}): Subcommand => ({
  usage: definition.usage,
  options: definition.options,
  prepare: (values) =>
    definition.args(values).map((args) => async (deps) => {
      const result = await definition.run(args, deps);
      return result.isOk()
        ? { code: 0, stdout: `${JSON.stringify(result.value)}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: `${NAME}: ${result.error.message}\n` };
    }),
});

class UsageInvalid extends TaggedError("UsageInvalid")<{
  message: string;
}> {}

const invalid = (message: string) => Result.err(new UsageInvalid({ message }));

const text = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};

const required = (values: Values, key: string) => {
  const value = text(values, key);
  return value === undefined
    ? invalid(`--${key} is required`)
    : Result.ok(value);
};

const oneOf = <T extends string>(
  values: Values,
  key: string,
  allowed: readonly T[],
) => {
  const value = text(values, key);
  if (value === undefined) return Result.ok(undefined);
  const chosen = allowed.find((each) => each === value);
  return chosen === undefined
    ? invalid(`--${key} must be one of ${allowed.join(", ")}`)
    : Result.ok(chosen);
};

const MODEL_OPTIONS = {
  model: { type: "string" },
  thinking: { type: "string" },
} as const;

// The Python taskctl's subcommands and options, which callers and permission rules already match.
const COMMANDS = {
  launch: subcommand({
    usage: "launch --request REQUEST [--model MODEL] [--thinking THINKING]",
    options: { request: { type: "string" }, ...MODEL_OPTIONS },
    args: (values) =>
      Result.gen(function* () {
        return Result.ok<LaunchArgs>({
          request: yield* required(values, "request"),
          model: text(values, "model"),
          thinking: text(values, "thinking"),
        });
      }),
    run: launch,
  }),
  review: subcommand({
    usage:
      "review --request REQUEST [--model MODEL] [--thinking THINKING] [--update-base] [--recover discard] [--ask FILE]",
    options: {
      request: { type: "string" },
      ask: { type: "string" },
      ...MODEL_OPTIONS,
      "update-base": { type: "boolean" },
      recover: { type: "string" },
    },
    args: (values) =>
      Result.gen(function* () {
        const ask = text(values, "ask");
        // The reviewer keeps the model it was started with, so a question takes no model either.
        if (
          ask !== undefined &&
          (values["update-base"] === true ||
            values.recover !== undefined ||
            values.model !== undefined ||
            values.thinking !== undefined)
        )
          return invalid(
            "--ask takes none of --update-base, --recover, --model and --thinking",
          );
        return Result.ok<ReviewArgs>({
          ask,
          request: yield* required(values, "request"),
          recover: yield* oneOf(values, "recover", ["discard"]),
          model: text(values, "model"),
          thinking: text(values, "thinking"),
          updateBase: values["update-base"] === true,
        });
      }),
    run: review,
  }),
  state: subcommand({
    usage: "state [--request REQUEST]",
    options: { request: { type: "string" } },
    args: (values) =>
      Result.ok<StateArgs>({ request: text(values, "request") }),
    run: state,
  }),
  resolve: subcommand({
    usage:
      "resolve --request REQUEST (--sent | --not-sent) [--thread-id THREAD_ID]",
    options: {
      request: { type: "string" },
      sent: { type: "boolean" },
      "not-sent": { type: "boolean" },
      "thread-id": { type: "string" },
    },
    args: (values) =>
      Result.gen(function* () {
        const request = yield* required(values, "request");
        if (values.sent === values["not-sent"])
          return invalid("exactly one of --sent and --not-sent is required");
        return Result.ok<ResolveArgs>({
          request,
          sent: values.sent === true,
          threadId: text(values, "thread-id"),
        });
      }),
    run: resolve,
  }),
  name: subcommand({
    usage: "name --pr PR",
    options: { pr: { type: "string" } },
    args: (values) =>
      Result.gen(function* () {
        return Result.ok<NameArgs>({ pr: yield* required(values, "pr") });
      }),
    run: name,
  }),
  watch: subcommand({
    usage:
      "watch [--dry-run [--pr PR]... | --release PR | --status | --sender | --link PR]",
    options: {
      "dry-run": { type: "boolean" },
      pr: { type: "string", multiple: true },
      release: { type: "string" },
      status: { type: "boolean" },
      sender: { type: "boolean" },
      link: { type: "string" },
    },
    args: (values) => {
      const args: WatchArgs = {
        dryRun: values["dry-run"] === true,
        prs: Array.isArray(values.pr) ? values.pr : [],
        release: text(values, "release"),
        status: values.status === true,
        sender: values.sender === true,
        link: text(values, "link"),
      };
      if (args.prs.length > 0 && !args.dryRun)
        return invalid("--pr is only for --dry-run");
      const modes = [
        args.release !== undefined,
        args.dryRun,
        args.status,
        args.sender,
        args.link !== undefined,
      ];
      if (modes.filter(Boolean).length > 1)
        return invalid(
          "use only one of --dry-run, --release, --status, --sender and --link",
        );
      return Result.ok(args);
    },
    run: watch,
  }),
  environment: subcommand({
    usage: "environment",
    options: {},
    args: () => Result.ok({}),
    run: (_args, deps) => environment(deps),
  }),
  cloud: subcommand({
    usage:
      "cloud (--link SESSION_OR_URL | --prompt-file FILE) --project PROJECT_ID [--title TITLE] [--model MODEL] [--thinking THINKING]",
    options: {
      link: { type: "string" },
      "prompt-file": { type: "string" },
      project: { type: "string" },
      title: { type: "string" },
      ...MODEL_OPTIONS,
    },
    args: (values) =>
      Result.gen(function* () {
        const link = text(values, "link");
        const promptFile = text(values, "prompt-file");
        if ((link === undefined) === (promptFile === undefined))
          return invalid("exactly one of --link and --prompt-file is required");
        return Result.ok<CloudArgs>({
          link,
          promptFile,
          project: yield* required(values, "project"),
          title: text(values, "title"),
          model: text(values, "model"),
          thinking: text(values, "thinking"),
        });
      }),
    run: cloud,
  }),
} satisfies Record<string, Subcommand>;

type Command = keyof typeof COMMANDS;

export type TaskRun = { code: number; stdout: string; stderr: string };

// harnexus-task runs apart from the checkout, so its help and crash name the checkout's report command.
export const FEEDBACK_HINT =
  "To report a bug, run bun run feedback --since 2h in the harnexus checkout and paste its output into a bug report.";

export const runTask = async (
  argv: readonly string[],
  deps: TaskDeps,
): Promise<TaskRun> => {
  const parsed = parseCommand(argv);
  if (parsed.isErr()) {
    const { message, usage, code } = parsed.error;
    return code === 0
      ? { code, stdout: `${usage}${FEEDBACK_HINT}\n`, stderr: "" }
      : { code, stdout: "", stderr: `${usage}${NAME}: ${message}\n` };
  }
  return await parsed.value(deps);
};

class UsageShown extends TaggedError("UsageShown")<{
  message: string;
  usage: string;
  code: number;
}> {}

const usageOf = (commands: readonly Command[]) =>
  `usage:\n${commands.map((command) => `  ${NAME} ${COMMANDS[command].usage}\n`).join("")}`;

const isCommand = (value: string | undefined): value is Command =>
  value !== undefined && Object.hasOwn(COMMANDS, value);

const parseCommand = (
  argv: readonly string[],
): Result<(deps: TaskDeps) => Promise<TaskRun>, UsageShown> => {
  const [command, ...rest] = argv;
  const all = Object.keys(COMMANDS) as Command[];
  if (!isCommand(command)) {
    const help = command === "-h" || command === "--help";
    return Result.err(
      new UsageShown({
        message: `expected a subcommand: ${all.join(", ")}`,
        usage: usageOf(all),
        code: help ? 0 : 2,
      }),
    );
  }
  const usage = usageOf([command]);
  const shown = (message: string, code = 2) =>
    Result.err(new UsageShown({ message, usage, code }));
  const { options, prepare } = COMMANDS[command];
  const parsed = parseOptions(rest, {
    ...options,
    help: { type: "boolean", short: "h" },
  });
  if (parsed.isErr()) return shown(parsed.error.message);
  if (parsed.value.help === true) return shown("", 0);
  const prepared = prepare(parsed.value);
  return prepared.isErr()
    ? shown(prepared.error.message)
    : Result.ok(prepared.value);
};
