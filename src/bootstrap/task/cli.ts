import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import { isObject } from "../../runtime/object.ts";
import { runCommand } from "../../runtime/process.boundary.ts";
import { type OptionTypes, parseOptions } from "./args.boundary.ts";
import { asText, type Fields, fail, jsonEqual, truthy } from "./format.ts";
import {
  callerId,
  candidate,
  chatId,
  codexHome,
  type Env,
  type GitRunner,
  gitIn,
  launchRequest,
  NAME,
  readJson,
  reviewPrompt,
  reviewRequest,
  sessionValue,
  workerPrompt,
} from "./request.ts";
import {
  launchSession,
  listState,
  reviewSession,
  type SaveJson,
  saveJson,
} from "./session.ts";

export type TaskDeps = { env: Env; runGit: GitRunner; saveJson: SaveJson };

export const TASK_DEPS = {
  runGit: (argv, env) => runCommand(argv[0] ?? "git", argv.slice(1), env),
  saveJson,
} satisfies Omit<TaskDeps, "env">;

type Args = {
  command: Command;
  request?: string;
  model?: string;
  thinking?: string;
  updateBase: boolean;
  sent: boolean;
  threadId?: string;
};

const worktreeTarget = (project: unknown) => ({
  type: "project",
  projectId: project,
  environment: { type: "worktree" } as Fields,
});

const launch = (args: Args, deps: TaskDeps) =>
  Result.gen(async function* () {
    const data = yield* Result.await(launchRequest(args.request ?? ""));
    const session = yield* Result.await(launchSession(data, deps));
    if (session.state !== null) {
      if (!jsonEqual(session.state.request, data))
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
      title: `Impl ${asText(data.taskId)}`,
      model: args.model || "claude-opus-5-5",
      thinking: args.thinking || "medium",
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
      Object.assign(sent, {
        target: worktreeTarget(data.projectId),
        title: `Review ${asText(data.taskId)}`,
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

const COMMANDS = { launch, review, state, resolve };

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
};

const USAGE = {
  launch: "launch --request REQUEST [--model MODEL] [--thinking THINKING]",
  review:
    "review --request REQUEST [--model MODEL] [--thinking THINKING] [--update-base]",
  state: "state [--request REQUEST]",
  resolve:
    "resolve --request REQUEST (--sent | --not-sent) [--thread-id THREAD_ID]",
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
  };
  const request = text("request");
  if (request !== undefined) args.request = request;
  else if (command !== "state") return shown("--request is required");
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
