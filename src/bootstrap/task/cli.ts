import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import type { CallOutcome } from "../../infra/codex/call-gateway.ts";
import {
  dryRun,
  release,
  status,
  watchForever,
} from "../../prwatch/commands.ts";
import { createGitHub } from "../../prwatch/github.ts";
import {
  githubPr,
  linkedChat,
  loadLink,
  loadSender,
  recordLink,
  recordSender,
} from "../../prwatch/store.ts";
import type { WatchPaths } from "../../prwatch/watcher.ts";
import { isObject } from "../../runtime/object.ts";
import { runCommand } from "../../runtime/process.boundary.ts";
import { type OptionTypes, parseOptions } from "./args.boundary.ts";
import { asText, type Fields, fail, jsonEqual, truthy } from "./format.ts";
import {
  absoluteOr,
  callerId,
  candidate,
  chatId,
  codexHome,
  type Env,
  type GitRunner,
  gitIn,
  homeOf,
  launchRequest,
  NAME,
  readJson,
  reviewPrompt,
  reviewRequest,
  sessionValue,
  workerPrompt,
} from "./request.ts";
import {
  callApp,
  launchOfThread,
  launchSession,
  listState,
  reviewProject,
  reviewSession,
  type SaveJson,
  saveJson,
  stateRoot,
} from "./session.ts";
import { programWatch } from "./watch-program.ts";
import { codexWorkers, senderFor } from "./watch-worker.ts";

export type TaskDeps = {
  env: Env;
  runGit: GitRunner;
  saveJson: SaveJson;
  // Only the watch writes as it runs, since it never returns.
  print: (line: string) => void;
};

export const TASK_DEPS = {
  runGit: (argv, env) => runCommand(argv[0] ?? "git", argv.slice(1), env),
  saveJson,
  print: (line) => {
    process.stdout.write(line);
  },
} satisfies Omit<TaskDeps, "env">;

type Args = {
  command: Command;
  request?: string;
  model?: string;
  thinking?: string;
  updateBase: boolean;
  sent: boolean;
  threadId?: string;
  pr?: string;
  prs: string[];
  dryRun: boolean;
  release?: string;
  status: boolean;
  sender: boolean;
  link?: string;
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

// The name is only shown, so renaming a task still finds its worker.
const withoutName = ({ displayName: _, ...rest }: Fields) => rest;

const sameTask = (recorded: unknown, data: Fields) =>
  isObject(recorded) && jsonEqual(withoutName(recorded), withoutName(data));

const launch = (args: Args, deps: TaskDeps) =>
  Result.gen(async function* () {
    const data = yield* Result.await(launchRequest(args.request ?? ""));
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
    const prompt = yield* Result.await(
      workerPrompt(data, join(codexHome(deps.env), "skills")),
    );
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

const review = (args: Args, deps: TaskDeps) =>
  Result.gen(async function* () {
    const git = gitIn(deps.runGit, deps.env);
    let data = yield* Result.await(
      reviewRequest(args.request ?? "", deps.env, git),
    );
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
    const sent: Fields = {
      prompt: yield* Result.await(
        reviewPrompt(data, join(codexHome(deps.env), "skills")),
      ),
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

const state = (args: Args, deps: TaskDeps) =>
  Result.gen(async function* () {
    if (args.request === undefined) return await listState(deps.env);
    const session = yield* Result.await(requestedSession(args.request, deps));
    return await session.show();
  });

const resolve = (args: Args, deps: TaskDeps) =>
  Result.gen(async function* () {
    const thread = args.threadId
      ? yield* chatId(args.threadId, "--thread-id")
      : null;
    const session = yield* Result.await(
      requestedSession(args.request ?? "", deps),
    );
    return await session.resolve(args.sent, thread);
  });

// A PR URL may carry a tab, query or fragment after its number, as when copied from the browser.
const PR_NUMBER =
  /^(?:#?([1-9][0-9]*)|https:\/\/\S+\/pull\/([1-9][0-9]*)(?:[/?#]\S*)?)$/;

// The number goes last so the title still reads as the task, while a search for the PR finds the worker.
const name = (args: Args, deps: TaskDeps) =>
  Result.gen(async function* () {
    const matched = PR_NUMBER.exec(args.pr ?? "");
    const number = matched?.[1] ?? matched?.[2];
    if (number === undefined)
      return fail("--pr must be a pull request URL or number");
    const worker = yield* callerId(deps.env);
    // Linked first and for any chat, so a worker the owner started by hand is still watched.
    // A worker naming its PR takes it over, as the latest worker on a PR is the one doing it.
    const watched = yield* Result.await(linkPr(deps, args.pr ?? "", worker));
    const request = yield* Result.await(launchOfThread(deps.env, worker));
    // Only a launched worker has a title to extend; another chat keeps its own.
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

// A linked chat nothing can send to is told so, since the link alone would read as watched.
// Never fails, since the link it reports on is already made.
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

// Kept apart from the title, so the watch finds the worker of a PR without reading thread names.
const linkPr = (deps: TaskDeps, value: string, worker: string) =>
  Result.gen(async function* () {
    const pr = githubPr(value);
    if (pr === null) return Result.ok(null);
    const root = watchPaths(deps.env).state;
    // Only the link is read, so an unreadable state never stops a chat from naming its PR.
    const current = yield* Result.await(loadLink(root, pr));
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
  config: join(
    absoluteOr(env.XDG_CONFIG_HOME, join(homeOf(env), ".config")),
    "harnexus/pr-watch.json",
  ),
  state: join(stateRoot(env), "watch"),
});

const watch = async (args: Args, deps: TaskDeps) => {
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

// Any chat can ask to be told about a PR without being renamed, but never takes a PR another chat is watched for.
const linkOnly = (deps: TaskDeps, value: string) =>
  Result.gen(async function* () {
    const worker = yield* callerId(deps.env);
    const pr = githubPr(value);
    if (pr === null) return fail(`${value} is not watched: ${NOT_LINKABLE}`);
    const current = yield* Result.await(
      linkedChat(watchPaths(deps.env).state, pr),
    );
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

const COMMANDS = { launch, review, state, resolve, name, watch };

type Command = keyof typeof COMMANDS;

export type TaskRun = { code: number; stdout: string; stderr: string };

export const runTask = async (
  argv: readonly string[],
  deps: TaskDeps,
): Promise<TaskRun> => {
  const parsed = parseCommand(argv);
  if (parsed.isErr()) {
    const { message, usage, code } = parsed.error;
    return code === 0
      ? { code, stdout: usage, stderr: "" }
      : { code, stdout: "", stderr: `${usage}${NAME}: ${message}\n` };
  }
  const result = await COMMANDS[parsed.value.command](parsed.value, deps);
  return result.isOk()
    ? { code: 0, stdout: `${JSON.stringify(result.value)}\n`, stderr: "" }
    : { code: 1, stdout: "", stderr: `${NAME}: ${result.error.message}\n` };
};

class UsageShown extends TaggedError("UsageShown")<{
  message: string;
  usage: string;
  code: number;
}> {}

const MODEL_OPTIONS = {
  request: { type: "string" },
  model: { type: "string" },
  thinking: { type: "string" },
} as const;

// The Python taskctl's subcommands and options, which callers and permission rules already match.
const OPTIONS: Record<Command, OptionTypes> = {
  launch: MODEL_OPTIONS,
  review: { ...MODEL_OPTIONS, "update-base": { type: "boolean" } },
  state: { request: { type: "string" } },
  resolve: {
    request: { type: "string" },
    sent: { type: "boolean" },
    "not-sent": { type: "boolean" },
    "thread-id": { type: "string" },
  },
  name: { pr: { type: "string" } },
  watch: {
    "dry-run": { type: "boolean" },
    pr: { type: "string", multiple: true },
    release: { type: "string" },
    status: { type: "boolean" },
    sender: { type: "boolean" },
    link: { type: "string" },
  },
};

const USAGE = {
  launch: "launch --request REQUEST [--model MODEL] [--thinking THINKING]",
  review:
    "review --request REQUEST [--model MODEL] [--thinking THINKING] [--update-base]",
  state: "state [--request REQUEST]",
  resolve:
    "resolve --request REQUEST (--sent | --not-sent) [--thread-id THREAD_ID]",
  name: "name --pr PR",
  watch:
    "watch [--dry-run [--pr PR]... | --release PR | --status | --sender | --link PR]",
} satisfies Record<Command, string>;

const usageOf = (commands: readonly Command[]) =>
  `usage:\n${commands.map((command) => `  ${NAME} ${USAGE[command]}\n`).join("")}`;

const isCommand = (value: string | undefined): value is Command =>
  value !== undefined && Object.hasOwn(COMMANDS, value);

const parseCommand = (argv: readonly string[]): Result<Args, UsageShown> => {
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
  const parsed = parseOptions(rest, {
    ...OPTIONS[command],
    help: { type: "boolean", short: "h" },
  });
  if (parsed.isErr()) return shown(parsed.error.message);
  const values = parsed.value;
  if (values.help === true) return shown("", 0);
  const text = (key: string) => {
    const value = values[key];
    return typeof value === "string" ? value : undefined;
  };
  const args: Args = {
    command,
    updateBase: values["update-base"] === true,
    sent: values.sent === true,
    dryRun: values["dry-run"] === true,
    status: values.status === true,
    sender: values.sender === true,
    prs: command === "watch" && Array.isArray(values.pr) ? values.pr : [],
  };
  const request = text("request");
  if (request !== undefined) args.request = request;
  else if (!["state", "name", "watch"].includes(command))
    return shown("--request is required");
  const pr = text("pr");
  if (pr !== undefined) args.pr = pr;
  else if (command === "name") return shown("--pr is required");
  const released = text("release");
  if (released !== undefined) args.release = released;
  const link = text("link");
  if (link !== undefined) args.link = link;
  if (args.prs.length > 0 && !args.dryRun)
    return shown("--pr is only for --dry-run");
  if (
    [
      released !== undefined,
      args.dryRun,
      args.status,
      args.sender,
      link !== undefined,
    ].filter(Boolean).length > 1
  )
    return shown(
      "use only one of --dry-run, --release, --status, --sender and --link",
    );
  if (command === "resolve" && values.sent === values["not-sent"])
    return shown("exactly one of --sent and --not-sent is required");
  const model = text("model");
  if (model !== undefined) args.model = model;
  const thinking = text("thinking");
  if (thinking !== undefined) args.thinking = thinking;
  const threadId = text("thread-id");
  if (threadId !== undefined) args.threadId = threadId;
  return Result.ok(args);
};
