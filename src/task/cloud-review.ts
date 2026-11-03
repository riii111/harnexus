import { join } from "node:path";

import { Result } from "better-result";

import { prepareDirectory, removeFile } from "../lib/fs.boundary.ts";
import { parseJson } from "../lib/json.boundary.ts";
import { type Fields, isObject } from "../lib/object.ts";
import {
  type ProcessRun,
  type ProcessRunFailed,
  runProcess,
} from "../lib/run.boundary.ts";
import { asText, detail, fail, jsonEqual, type TaskFailed } from "./format.ts";
import {
  readRecords,
  type SaveJson,
  settlePending,
  stateDirectory,
} from "./records.ts";
import {
  candidate,
  type Env,
  type Git,
  io,
  readText,
  reviewFields,
  reviewRequest,
  sessionValue,
} from "./request.ts";
import {
  acquire,
  configuredBinary,
  milliseconds,
  release,
} from "./run-lock.ts";
import { taskPrompt } from "./templates.ts";

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_MODEL = "gpt-6.1-sol";
const DEFAULT_THINKING = "medium";
// The reviewer's reply template for a run whose answer is its own output.
const REPLY_TO = "Cloud";
const THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERDICT = /^\s*判定:\s*(LGTM|修正必要|判定保留)/m;
const NO_ROLLOUT = "no rollout found";

type CloudReviewArgs = {
  request: string;
  model?: string;
  thinking?: string;
  updateBase: boolean;
  recover?: "discard";
};

type CloudReviewDeps = { env: Env; saveJson: SaveJson; git: Git };

const directory = (env: Env, checkout: string, taskId: string) =>
  // One reviewer per task and checkout, as in the app.
  stateDirectory(env, "cloud-review", `${checkout}\0${taskId}`);

type Reply = {
  threadId: string | null;
  answer: string | null;
  failure: string | null;
};

const replyOf = (stdout: string): Reply => {
  const reply: Reply = { threadId: null, answer: null, failure: null };
  // codex exec --json prints one event per line: the thread it runs, each item, and how the turn ended.
  for (const line of stdout.split("\n")) {
    const parsed = parseJson(line);
    if (parsed.isErr() || !isObject(parsed.value)) continue;
    const event = parsed.value;
    if (event.type === "thread.started" && typeof event.thread_id === "string")
      reply.threadId = THREAD_ID.test(event.thread_id) ? event.thread_id : null;
    if (
      event.type === "item.completed" &&
      isObject(event.item) &&
      event.item.type === "agent_message" &&
      typeof event.item.text === "string"
    )
      reply.answer = event.item.text;
    if (event.type === "turn.failed")
      reply.failure = isObject(event.error)
        ? asText(event.error.message)
        : "the turn failed";
  }

  return reply;
};

const recoveryHint =
  "its result is unknown, so it is not sent again on its own. Check the reviewer, then rerun with --recover discard to send the candidate again";

type CodexLaunch = { bin: string; timeoutMs: number; killGraceMs: number };

const codexLaunch = (env: Env) =>
  Result.gen(function* () {
    const bin = yield* configuredBinary(env, "HARNEXUS_CODEX_BIN", "codex");
    const timeoutMs = yield* milliseconds(
      env,
      "HARNEXUS_REVIEW_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    );
    const killGraceMs = yield* milliseconds(
      env,
      "HARNEXUS_REVIEW_KILL_GRACE_MS",
      DEFAULT_KILL_GRACE_MS,
    );
    return Result.ok<CodexLaunch>({ bin, timeoutMs, killGraceMs });
  });

const reviewerOf = (state: Fields | null) =>
  typeof state?.reviewer === "string" && THREAD_ID.test(state.reviewer)
    ? state.reviewer
    : null;

const checkContinuation = async (
  state: Fields | null,
  previous: Fields,
  data: Fields,
): Promise<Result<void, TaskFailed>> => {
  for (const key of ["taskId", "workerAI", "checkout"]) {
    const before = await sessionValue(previous, key);
    if (!jsonEqual(before, await sessionValue(data, key)))
      return fail(`review session must keep the original ${key}`);
  }

  // A head the reviewer could not judge is sent again once what it lacked is given, such as a document it could not read.
  // A state saved before verdicts were kept has none, and counts as judged.
  const judged = state?.verdict !== "判定保留" && state?.verdict !== null;
  if (judged && jsonEqual(previous.head ?? null, data.head))
    return fail(
      `head ${asText(data.head)} was already reviewed by ${asText(state?.reviewer)}; commit a fix before asking again`,
    );

  return Result.ok();
};

const reviewArgv = (
  reviewer: string | null,
  checkout: string,
  { model, thinking }: Pick<CloudReviewArgs, "model" | "thinking">,
) => {
  // An empty value falls back like a missing one, as for a reviewer chat in the app.
  const chosenModel = model || (reviewer === null ? DEFAULT_MODEL : undefined);
  const chosenThinking =
    thinking || (reviewer === null ? DEFAULT_THINKING : undefined);
  const chosen = [
    ...(chosenModel === undefined ? [] : ["-m", chosenModel]),
    ...(chosenThinking === undefined
      ? []
      : ["-c", `model_reasoning_effort=${JSON.stringify(chosenThinking)}`]),
  ];
  // The reviewer only reads; resume has no --sandbox or --cd, so it takes the setting and runs in the checkout.
  return reviewer === null
    ? [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "-C",
        checkout,
        ...chosen,
        "-",
      ]
    : [
        "exec",
        "resume",
        reviewer,
        "--json",
        "-c",
        'sandbox_mode="read-only"',
        ...chosen,
        "-",
      ];
};

type Cleanup = () => Promise<Result<void, TaskFailed>>;

// What a finished codex run answered. A run that reviewed nothing clears the pending record so the candidate can be sent again; one whose result is unknown leaves it.
const reviewReply = (
  ran: Result<ProcessRun, ProcessRunFailed>,
  reviewer: string | null,
  { unsent, forgetReviewer }: { unsent: Cleanup; forgetReviewer: Cleanup },
) =>
  Result.gen(async function* () {
    if (ran.isErr()) {
      if (!ran.error.started) yield* Result.await(unsent());
      return fail(
        ran.error.started
          ? `${ran.error.message}; ${recoveryHint}`
          : ran.error.message,
      );
    }

    const { status, stdout, stderr, ended } = ran.value;
    // A stopped run may have started its reviewer, which is named so it can be checked.
    if (ended !== "exit") {
      const started = replyOf(stdout).threadId ?? reviewer;
      return fail(
        `codex was stopped (${ended === "timeout" ? "timeout" : "output over the limit"})${started === null ? "" : ` in reviewer ${started}`}; ${recoveryHint}`,
      );
    }

    const reply = replyOf(stdout);
    // A run that failed or never named its thread reviewed nothing, so the candidate can be sent again.
    if (status !== 0 || reply.failure !== null || reply.answer === null) {
      yield* Result.await(unsent());
      // The reviewer's record lives in this machine's Codex home, which a rebuilt Cloud machine no longer has.
      if (reviewer !== null && stderr.includes(NO_ROLLOUT)) {
        yield* Result.await(forgetReviewer());
        return fail(
          `reviewer ${reviewer} is gone from this machine; run review again to start a new reviewer`,
        );
      }

      return fail(
        `codex did not review (exit ${status}): ${detail(reply.failure ?? stderr)}`,
      );
    }

    const threadId = reply.threadId ?? reviewer;
    if (threadId === null) {
      yield* Result.await(unsent());
      return fail("codex answered without naming its thread");
    }

    return Result.ok({ threadId, answer: reply.answer });
  });

const locked = (
  args: CloudReviewArgs,
  deps: CloudReviewDeps,
  dir: string,
  requested: Fields,
) =>
  Result.gen(async function* () {
    const records = yield* Result.await(readRecords(dir));
    const { statePath, pendingPath, state } = records;
    yield* Result.await(
      settlePending(records, args.recover, {
        blocked: (pending) =>
          `the review of head ${asText(pending.head)} did not report back: ${recoveryHint}`,
        nothingPending: "--recover applies only when a review is pending",
      }),
    );

    const previous = isObject(state?.candidate) ? state.candidate : null;
    const data = yield* Result.await(
      candidate(requested, previous, args.updateBase, deps.git),
    );
    if (previous !== null)
      yield* Result.await(checkContinuation(state, previous, data));

    const fields = yield* Result.await(reviewFields(data, REPLY_TO));
    const prompt = yield* Result.await(
      taskPrompt(deps.env, "reviewer", fields),
    );
    const { bin, ...limits } = yield* codexLaunch(deps.env);

    const reviewer = reviewerOf(state);
    const checkout = String(data.checkout);
    const argv = reviewArgv(reviewer, checkout, args);

    yield* Result.await(
      deps.saveJson(
        pendingPath,
        {
          reviewer,
          base: data.base,
          head: data.head,
          startedAt: new Date().toISOString(),
        },
        { exclusive: false },
      ),
    );
    const unsent = () => io(removeFile(pendingPath));
    const ran = await runProcess(bin, argv, prompt, {
      cwd: checkout,
      env: deps.env,
      ...limits,
    });
    const { threadId, answer } = yield* Result.await(
      reviewReply(ran, reviewer, {
        unsent,
        forgetReviewer: () =>
          deps.saveJson(
            statePath,
            { ...state, reviewer: null, updatedAt: new Date().toISOString() },
            { exclusive: false },
          ),
      }),
    );

    const heads: unknown[] = Array.isArray(state?.heads) ? state.heads : [];
    const verdict = VERDICT.exec(answer)?.[1] ?? null;
    const saved = await deps.saveJson(
      statePath,
      {
        reviewer: threadId,
        candidate: data,
        verdict,
        heads: [...heads, data.head],
        updatedAt: new Date().toISOString(),
      },
      { exclusive: false },
    );
    // The pending record stays, so the review is not taken as done; its answer is still shown.
    if (saved.isErr())
      return fail(
        `${saved.error.message}; reviewer ${threadId} answered, but it was not recorded, ${recoveryHint}. Its answer:\n${answer}`,
      );
    yield* Result.await(unsent());
    return Result.ok<Fields>({
      status: "completed",
      verdict,
      taskId: data.taskId,
      base: data.base,
      head: data.head,
      reviewer: threadId,
      answer,
      state: statePath,
    });
  });

// Passes a message, such as a question the user asked in the reviewer's chat, to the task's reviewer, answering with its reply; the reviewer's verdict and the reviewed head stay as they were.
const asked = (
  ask: string,
  deps: CloudReviewDeps,
  dir: string,
  requested: Fields,
) =>
  Result.gen(async function* () {
    const message = yield* Result.await(readText(ask));
    if (message.trim() === "") return fail("the --ask file is empty");
    const { state } = yield* Result.await(readRecords(dir));
    const reviewer = reviewerOf(state);
    if (reviewer === null)
      return fail("this task has no reviewer yet; run review first");
    const { bin, ...limits } = yield* codexLaunch(deps.env);
    const ran = await runProcess(
      bin,
      [
        "exec",
        "resume",
        reviewer,
        "--json",
        "-c",
        'sandbox_mode="read-only"',
        "-",
      ],
      message,
      {
        cwd: String(requested.checkout),
        env: deps.env,
        ...limits,
      },
    );
    if (ran.isErr()) return fail(ran.error.message);
    const { status, stdout, stderr, ended } = ran.value;
    if (ended !== "exit")
      return fail(
        `codex was stopped (${ended === "timeout" ? "timeout" : "output over the limit"}) in reviewer ${reviewer}; it may have answered, so check before asking again`,
      );
    const reply = replyOf(stdout);
    if (status !== 0 || reply.failure !== null || reply.answer === null)
      return fail(
        `reviewer ${reviewer} did not answer (exit ${status}): ${detail(reply.failure ?? stderr)}`,
      );
    const reviewed = isObject(state?.candidate) ? state.candidate : null;
    return Result.ok<Fields>({
      status: "completed",
      kind: "reply",
      // Tells this reply from another of the same text, such as the same answer to a question asked again.
      askedAt: new Date().toISOString(),
      verdict: VERDICT.exec(reply.answer)?.[1] ?? null,
      taskId: requested.taskId,
      head: reviewed?.head ?? null,
      reviewer,
      answer: reply.answer,
    });
  });

// Reviews in a Claude Code cloud session with a Codex CLI run beside the worker, answering with its result instead of a chat in the app; with ask, passes that message to the same reviewer instead.
export const cloudReview = (
  args: CloudReviewArgs & { ask?: string },
  deps: CloudReviewDeps,
) =>
  Result.gen(async function* () {
    const data = yield* Result.await(
      reviewRequest(args.request, deps.env, deps.git, { cloud: true }),
    );
    if (!Object.hasOwn(data, "workerChatId"))
      data.workerChatId = deps.env.CLAUDE_CODE_SESSION_ID || "cloud";
    const dir = directory(deps.env, String(data.checkout), String(data.taskId));
    yield* Result.await(io(prepareDirectory(dir)));
    const lock = join(dir, "lock.json");
    const token = yield* Result.await(acquire(lock, "review"));
    const done =
      args.ask === undefined
        ? await locked(args, deps, dir, data)
        : await asked(args.ask, deps, dir, data);
    await release(lock, token);
    return done;
  });
