import { join } from "node:path";
import { Result } from "better-result";
import { isObject } from "../../runtime/object.ts";
import { runCommand } from "../../runtime/process.boundary.ts";
import {
  type Fields,
  fail,
  jsonEqual,
  pyDumps,
  pyStr,
  truthy,
} from "./format.ts";
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
          `${pyStr(data.taskId)} already has worker ${pyStr(session.state.threadId)} ` +
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
      title: `Impl ${pyStr(data.taskId)}`,
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
          `head ${pyStr(data.head)} was already sent to reviewer ` +
            `${pyStr(session.state?.reviewer)}; wait for its result`,
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
        title: `Review ${pyStr(data.taskId)}`,
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
  const parsed = parseArgs(argv);
  if ("exit" in parsed) return parsed.exit;
  const result = await COMMANDS[parsed.command](parsed, deps);
  return result.isOk()
    ? { code: 0, stdout: `${pyDumps(result.value)}\n`, stderr: "" }
    : { code: 1, stdout: "", stderr: `${NAME}: ${result.error.message}\n` };
};

type Option = {
  flag: string;
  key: "request" | "model" | "thinking" | "threadId" | "updateBase" | "sent";
  value?: string;
  required?: boolean;
  help?: string;
  notSent?: boolean;
};

const REQUEST: Option = { flag: "--request", key: "request", value: "REQUEST" };
const MODEL_OPTIONS: Option[] = [
  { ...REQUEST, required: true },
  { flag: "--model", key: "model", value: "MODEL" },
  { flag: "--thinking", key: "thinking", value: "THINKING" },
];

// The Python taskctl's argparse definitions, which callers and permission rules already match.
const PARSERS: Record<Command, { help: string; options: Option[] }> = {
  launch: {
    help: "create a worker thread once per projectId and taskId",
    options: MODEL_OPTIONS,
  },
  review: {
    help: "send the current head to the worker's reviewer",
    options: [
      ...MODEL_OPTIONS,
      {
        flag: "--update-base",
        key: "updateBase",
        help: "fix a new base already integrated into head",
      },
    ],
  },
  state: { help: "show recorded state", options: [REQUEST] },
  resolve: {
    help: "settle an unknown or refused send after checking the App",
    options: [
      { ...REQUEST, required: true },
      { flag: "--sent", key: "sent" },
      { flag: "--not-sent", key: "sent", notSent: true },
      { flag: "--thread-id", key: "threadId", value: "THREAD_ID" },
    ],
  },
};

const CHOICES = Object.keys(PARSERS) as Command[];
const TOP_USAGE = `usage: ${NAME} [-h] {${CHOICES.join(",")}} ...`;
const TOP_HELP = `${TOP_USAGE}

Launch task workers and request independent reviews through harnexus.

positional arguments:
  {${CHOICES.join(",")}}
${CHOICES.map((name) => `    ${name.padEnd(20)}${PARSERS[name].help}`).join("\n")}

options:
  -h, --help            show this help message and exit
`;

const usageOf = (command: Command) => {
  const parts = PARSERS[command].options.map((option) => {
    if (option.flag === "--sent") return "(--sent | --not-sent)";
    if (option.notSent) return "";
    const text =
      option.value === undefined
        ? option.flag
        : `${option.flag} ${option.value}`;
    return option.required ? text : `[${text}]`;
  });
  return `usage: ${NAME} ${command} [-h] ${parts.filter((part) => part !== "").join(" ")}`;
};

const helpOf = (command: Command) =>
  `${usageOf(command)}

options:
  -h, --help            show this help message and exit
${PARSERS[command].options
  .map((option) => {
    const text =
      option.value === undefined
        ? option.flag
        : `${option.flag} ${option.value}`;
    return `  ${option.help === undefined ? text : `${text.padEnd(22)}${option.help}`}`;
  })
  .join("\n")}
`;

const usageError = (usage: string, prog: string, message: string) => ({
  exit: {
    code: 2,
    stdout: "",
    stderr: `${usage}\n${prog}: error: ${message}\n`,
  },
});

const helpExit = (text: string) => ({
  exit: { code: 0, stdout: text, stderr: "" },
});

const isNegativeNumber = (arg: string) => /^-\d+$|^-\d*\.\d+$/.test(arg);

// Mirrors argparse: unique prefixes of long options, --opt=value, and values that look like options are refused.
const parseArgs = (argv: readonly string[]): Args | { exit: TaskRun } => {
  const [first, ...rest] = argv;
  const topError = (message: string) => usageError(TOP_USAGE, NAME, message);
  if (first === undefined || (first.startsWith("-") && first !== "-")) {
    if (
      first !== undefined &&
      ["-h", "--h", "--he", "--hel", "--help"].includes(first)
    )
      return helpExit(TOP_HELP);
    return topError("the following arguments are required: command");
  }
  if (!(CHOICES as string[]).includes(first))
    return topError(
      `argument command: invalid choice: '${first}' (choose from ${CHOICES.map((c) => `'${c}'`).join(", ")})`,
    );
  const command = first as Command;
  const options = PARSERS[command].options;
  const flags = ["--help", ...options.map((option) => option.flag)];
  const subError = (message: string) =>
    usageError(usageOf(command), `${NAME} ${command}`, message);
  const match = (arg: string) => {
    if (arg === "-h") return { names: ["--help"], explicit: undefined };
    if (!arg.startsWith("--") || arg === "--")
      return { names: [], explicit: undefined };
    const at = arg.indexOf("=");
    const name = at === -1 ? arg : arg.slice(0, at);
    const explicit = at === -1 ? undefined : arg.slice(at + 1);
    const names = flags.includes(name)
      ? [name]
      : flags.filter((flag) => flag.startsWith(name));
    return { names, explicit };
  };
  const isValue = (arg: string) =>
    !arg.startsWith("-") ||
    arg === "-" ||
    (match(arg).names.length === 0 &&
      (isNegativeNumber(arg) || arg.includes(" ")));
  const args: Args = { command, updateBase: false, sent: false };
  const seen = new Set<string>();
  const extras: string[] = [];
  let positional = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (positional || isValue(arg)) {
      extras.push(arg);
      continue;
    }
    if (arg === "--") {
      positional = true;
      continue;
    }
    const { names, explicit } = match(arg);
    if (names.length > 1)
      return subError(
        `ambiguous option: ${arg.split("=")[0]} could match ${names.join(", ")}`,
      );
    const name = names[0];
    if (name === undefined) {
      extras.push(arg);
      continue;
    }
    if (name === "--help") return helpExit(helpOf(command));
    const option = options.find((candidate) => candidate.flag === name);
    if (option === undefined) continue;
    if (option.key === "sent") {
      const other = option.notSent ? "--sent" : "--not-sent";
      if (seen.has(other))
        return subError(`argument ${name}: not allowed with argument ${other}`);
    }
    seen.add(name);
    if (option.value === undefined) {
      if (explicit !== undefined)
        return subError(
          `argument ${name}: ignored explicit argument '${explicit}'`,
        );
      if (option.key === "sent") args.sent = !option.notSent;
      else if (option.key === "updateBase") args.updateBase = true;
      continue;
    }
    let value = explicit;
    if (value === undefined) {
      const next = rest[i + 1];
      if (next === undefined || !isValue(next))
        return subError(`argument ${name}: expected one argument`);
      value = next;
      i += 1;
    }
    if (option.key !== "updateBase" && option.key !== "sent")
      args[option.key] = value;
  }
  const missing = options
    .filter((option) => option.required && !seen.has(option.flag))
    .map((option) => option.flag);
  if (missing.length > 0)
    return subError(
      `the following arguments are required: ${missing.join(", ")}`,
    );
  if (command === "resolve" && !seen.has("--sent") && !seen.has("--not-sent"))
    return subError("one of the arguments --sent --not-sent is required");
  if (extras.length > 0)
    return topError(`unrecognized arguments: ${extras.join(" ")}`);
  return args;
};
