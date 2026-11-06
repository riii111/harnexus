import { parseOptions } from "../lib/args.boundary.ts";
import { readRegularTextFile } from "../lib/fs.boundary.ts";
import { parseJson } from "../lib/json.boundary.ts";
import { isObject } from "../lib/object.ts";
import { type ClientAnswer, callV1, EXIT, exitOf } from "./call-client.ts";

export type CommandRun = { code: number; stdout: string; stderr: string };

type Deps = {
  env: Record<string, string | undefined>;
  cwd: string;
  readStdin: () => Promise<string>;
};

const NAME = "harnexus";

const USAGE = `usage:
  ${NAME} cloud (--link SESSION_OR_URL | --prompt-file FILE) [--project PROJECT_ID] [--title TITLE] [--model MODEL] [--thinking THINKING]
  ${NAME} call < REQUEST_JSON
`;

// Exit statuses follow the call outcome, so 2 (never sent, safe to send again) is told apart from 3 (unknown, never send again).
export const runHarnexus = async (
  argv: readonly string[],
  deps: Deps,
): Promise<CommandRun> => {
  const [command, ...rest] = argv;
  if (command === "-h" || command === "--help")
    return { code: 0, stdout: USAGE, stderr: "" };
  if (command === "cloud") return cloud(rest, deps);
  if (command === "call") return call(rest, deps);
  return usageError("expected a subcommand: cloud, call");
};

const usageError = (message: string): CommandRun => ({
  code: EXIT.invalid,
  stdout: "",
  stderr: `${USAGE}${NAME}: ${message}\n`,
});

const answered = (answer: ClientAnswer, command: string): CommandRun => ({
  code: exitOf(answer.outcome),
  stdout: `${JSON.stringify(answer)}\n`,
  stderr:
    answer.outcome === "done"
      ? ""
      : `${NAME} ${command}: ${answer.outcome}${typeof answer.message === "string" ? `: ${answer.message}` : ""}\n`,
});

const callerOf = (env: Record<string, string | undefined>) => {
  const value = env.CODEX_THREAD_ID;
  return value === undefined || value === "" ? null : value;
};

// Sends one call socket request read from stdin; the thread defaults to the one the command runs in.
const call = async (args: readonly string[], deps: Deps) => {
  if (args.length > 0) return usageError("call takes its request on stdin");
  const parsed = parseJson((await deps.readStdin()).trim()).unwrapOr(null);
  if (!isObject(parsed) || typeof parsed.tool !== "string")
    return usageError('expected {"tool","arguments"[,"threadId"]} on stdin');
  const threadId =
    typeof parsed.threadId === "string" ? parsed.threadId : callerOf(deps.env);
  if (threadId === null)
    return usageError("CODEX_THREAD_ID is not set and no threadId was given");
  const toolArgs = parsed.arguments ?? {};
  if (!isObject(toolArgs)) return usageError("arguments must be an object");
  return answered(
    await callV1(deps.env, {
      threadId,
      tool: parsed.tool,
      arguments: toolArgs,
    }),
    "call",
  );
};

// Opens a chat for a Cloud session, new or already started; it never switches the chat it runs in.
const cloud = async (args: readonly string[], deps: Deps) => {
  const options = parseOptions(args, {
    link: { type: "string" },
    "prompt-file": { type: "string" },
    project: { type: "string" },
    title: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    help: { type: "boolean", short: "h" },
  });
  if (options.isErr()) return usageError(options.error.message);
  const values = options.value;
  if (values.help === true) return { code: 0, stdout: USAGE, stderr: "" };
  const text = (key: string) =>
    typeof values[key] === "string" ? values[key] : undefined;
  const link = text("link");
  const promptFile = text("prompt-file");
  if ((link === undefined) === (promptFile === undefined))
    return usageError("exactly one of --link and --prompt-file is required");
  const caller = callerOf(deps.env);
  if (caller === null)
    return usageError(`CODEX_THREAD_ID is not set; run ${NAME} from a thread`);
  let prompt: string | undefined;
  if (promptFile !== undefined) {
    const read = await readRegularTextFile(promptFile);
    if (read.isErr()) return usageError(read.error.message);
    if (read.value.trim() === "") return usageError("the prompt file is empty");
    prompt = read.value;
  }

  const answer = await callV1(deps.env, {
    threadId: caller,
    tool: "cloud_open",
    arguments: {
      cwd: deps.cwd,
      ...(link !== undefined && { link }),
      ...(prompt !== undefined && { prompt }),
      ...(text("project") !== undefined && { projectId: text("project") }),
      ...(text("title") !== undefined && { title: text("title") }),
      ...(text("model") !== undefined && { model: text("model") }),
      ...(text("thinking") !== undefined && { thinking: text("thinking") }),
    },
  });
  // A chat opened is printed as its result alone, so a script reads threadId and cloudSessionId at the top level.
  if (answer.outcome === "done" && isObject(answer.result))
    return {
      code: EXIT.done,
      stdout: `${JSON.stringify(answer.result)}\n`,
      stderr: "",
    };
  return answered(answer, "cloud");
};
