import { createHash } from "node:crypto";
import { join } from "node:path";
import { Result } from "better-result";
import { runClaude } from "../../infra/claude/run.boundary.ts";
import { prepareDirectory, removeFile } from "../../runtime/fs.boundary.ts";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import { acquire, milliseconds, release } from "./cloud.ts";
import { asText, type Fields, fail, jsonEqual } from "./format.ts";
import {
  candidate,
  type Env,
  type Git,
  ioFailed,
  reviewFields,
  reviewRequest,
  sessionValue,
} from "./request.ts";
import { load, type SaveJson, stateRoot } from "./session.ts";
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

export type CloudReviewArgs = {
  request: string;
  model?: string;
  thinking?: string;
  updateBase: boolean;
  recover?: string;
};

export type CloudReviewDeps = { env: Env; saveJson: SaveJson; git: Git };

const binary = (env: Env) => {
  const configured = env.HARNEXUS_CODEX_BIN;
  if (configured === undefined || configured === "") return Result.ok("codex");
  return configured.startsWith("/")
    ? Result.ok(configured)
    : fail("HARNEXUS_CODEX_BIN must be an absolute path");
};

// One reviewer per task and checkout, as in the app.
const directory = (env: Env, checkout: string, taskId: string) =>
  join(
    stateRoot(env),
    "cloud-review",
    createHash("sha256")
      .update(`${checkout}\0${taskId}`)
      .digest("hex")
      .slice(0, 16),
  );

type Reply = {
  threadId: string | null;
  answer: string | null;
  failure: string | null;
};

// codex exec --json prints one event per line: the thread it runs, each item, and how the turn ended.
const replyOf = (stdout: string): Reply => {
  const reply: Reply = { threadId: null, answer: null, failure: null };
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

const detail = (text: string) => text.trim().slice(0, 500);

const recoveryHint =
  "its result is unknown, so it is not sent again on its own. Check the reviewer, then rerun with --recover discard to send the candidate again";

const locked = (
  args: CloudReviewArgs,
  deps: CloudReviewDeps,
  dir: string,
  requested: Fields,
) =>
  Result.gen(async function* () {
    const statePath = join(dir, "state.json");
    const pendingPath = join(dir, "pending.json");
    const loaded = yield* Result.await(load(statePath));
    const state = isObject(loaded) ? loaded : null;
    const pending = yield* Result.await(load(pendingPath));
    if (args.recover !== undefined && args.recover !== "discard")
      return fail("review takes only --recover discard");
    if (isObject(pending)) {
      if (args.recover !== "discard")
        return fail(
          `the review of head ${asText(pending.head)} did not report back: ${recoveryHint}`,
        );
      yield* Result.await(
        removeFile(pendingPath).then((r) => r.mapError(ioFailed)),
      );
    } else if (args.recover !== undefined) {
      return fail("--recover applies only when a review is pending");
    }

    const previous = isObject(state?.candidate) ? state.candidate : null;
    const data = yield* Result.await(
      candidate(requested, previous, args.updateBase, deps.git),
    );
    if (previous !== null) {
      for (const key of ["taskId", "workerAI", "checkout"]) {
        const before = await sessionValue(previous, key);
        if (!jsonEqual(before, await sessionValue(data, key)))
          return fail(`review session must keep the original ${key}`);
      }
      if (jsonEqual(previous.head ?? null, data.head))
        return fail(
          `head ${asText(data.head)} was already reviewed by ${asText(state?.reviewer)}; commit a fix before asking again`,
        );
    }
    const fields = yield* Result.await(reviewFields(data, REPLY_TO));
    const prompt = yield* Result.await(
      taskPrompt(deps.env, "reviewer", fields),
    );
    const bin = yield* binary(deps.env);
    const timeoutMs = yield* milliseconds(
      deps.env,
      "HARNEXUS_REVIEW_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    );
    const killGraceMs = yield* milliseconds(
      deps.env,
      "HARNEXUS_REVIEW_KILL_GRACE_MS",
      DEFAULT_KILL_GRACE_MS,
    );

    const reviewer =
      typeof state?.reviewer === "string" && THREAD_ID.test(state.reviewer)
        ? state.reviewer
        : null;
    const checkout = String(data.checkout);
    // An empty value falls back like a missing one, as for a reviewer chat in the app.
    const model = args.model || (reviewer === null ? DEFAULT_MODEL : undefined);
    const thinking =
      args.thinking || (reviewer === null ? DEFAULT_THINKING : undefined);
    const chosen = [
      ...(model === undefined ? [] : ["-m", model]),
      ...(thinking === undefined
        ? []
        : ["-c", `model_reasoning_effort=${JSON.stringify(thinking)}`]),
    ];
    // The reviewer only reads; resume has no --sandbox or --cd, so it takes the setting and runs in the checkout.
    const argv =
      reviewer === null
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
    const unsent = () =>
      removeFile(pendingPath).then((r) => r.mapError(ioFailed));
    const ran = await runClaude(bin, argv, prompt, {
      cwd: checkout,
      env: deps.env,
      timeoutMs,
      killGraceMs,
    });
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
        yield* Result.await(
          deps.saveJson(
            statePath,
            { ...state, reviewer: null, updatedAt: new Date().toISOString() },
            { exclusive: false },
          ),
        );
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
    const heads = Array.isArray(state?.heads) ? state.heads : [];
    const saved = await deps.saveJson(
      statePath,
      {
        reviewer: threadId,
        candidate: data,
        heads: [...heads, data.head],
        updatedAt: new Date().toISOString(),
      },
      { exclusive: false },
    );
    // The pending record stays, so the review is not taken as done; its answer is still shown.
    if (saved.isErr())
      return fail(
        `${saved.error.message}; reviewer ${threadId} answered, but it was not recorded, ${recoveryHint}. Its answer:\n${reply.answer}`,
      );
    yield* Result.await(unsent());
    return Result.ok<Fields>({
      status: "completed",
      verdict: VERDICT.exec(reply.answer)?.[1] ?? null,
      taskId: data.taskId,
      base: data.base,
      head: data.head,
      reviewer: threadId,
      answer: reply.answer,
      state: statePath,
    });
  });

// In a Claude Code cloud session the reviewer is a Codex CLI run beside the worker, so review answers with its result instead of a chat in the app.
export const cloudReview = (args: CloudReviewArgs, deps: CloudReviewDeps) =>
  Result.gen(async function* () {
    const data = yield* Result.await(
      reviewRequest(args.request, deps.env, deps.git, { anyCheckout: true }),
    );
    if (!Object.hasOwn(data, "workerChatId"))
      data.workerChatId = deps.env.CLAUDE_CODE_SESSION_ID || "cloud";
    const dir = directory(deps.env, String(data.checkout), String(data.taskId));
    yield* Result.await(
      prepareDirectory(dir).then((made) => made.mapError(ioFailed)),
    );
    const lock = join(dir, "lock.json");
    const token = yield* Result.await(acquire(lock, "review"));
    const done = await locked(args, deps, dir, data);
    await release(lock, token);
    return done;
  });
