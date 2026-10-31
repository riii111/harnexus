import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Result } from "better-result";
import { printAnswer, UUID } from "../infra/claude/print.ts";
import {
  checkAccess,
  isDirectory,
  prepareDirectory,
  removeFile,
  writeFileExclusive,
} from "../runtime/fs.boundary.ts";
import { type Fields, isObject } from "../runtime/object.ts";
import { processAlive, runProcess } from "../runtime/run.boundary.ts";
import { asText, detail, fail, isBlank } from "./format.ts";
import {
  load,
  type Recovery,
  readRecords,
  type SaveJson,
  settlePending,
  stateDirectory,
} from "./records.ts";
import { type Env, io, readText, singleLine } from "./request.ts";

export const CLOUD_CLAUDE_BIN = "/workspace/.cloud-setup/bin/claude-cloud";
const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_.:/-]{0,127}$/u;
const NETWORK_EXIT = 75;

export const PERMISSION_MODES = ["auto", "plan"] as const;

export type ClaudeArgs = {
  mode: "start" | "resume" | "state";
  session: string;
  promptFile?: string;
  model?: string;
  cwd?: string;
  // Absent on a resume keeps the mode the session has; absent on a start means auto.
  permissionMode?: string;
  recover?: Recovery;
};

export type CloudDeps = { env: Env; saveJson: SaveJson; cwd?: string };

const directory = (env: Env, key: string) =>
  stateDirectory(env, "cloud-claude", key);

export const configuredBinary = (env: Env, name: string, fallback: string) => {
  const configured = env[name];
  if (configured === undefined || configured === "") return Result.ok(fallback);
  return configured.startsWith("/")
    ? Result.ok(configured)
    : fail(`${name} must be an absolute path`);
};

export const milliseconds = (env: Env, name: string, fallback: number) => {
  const value = env[name];
  if (value === undefined || value === "") return Result.ok(fallback);
  return /^[1-9][0-9]{0,9}$/.test(value)
    ? Result.ok(Number(value))
    : fail(`${name} must be a positive number of milliseconds`);
};

const heldBy = async (path: string) => {
  const held = await load(path);
  return held.isOk() && isObject(held.value) ? held.value : null;
};

const dead = (holder: Fields | null) =>
  typeof holder?.pid === "number" && !processAlive(holder.pid);

// Taking over a dead holder goes through a second exclusive file, so of several runs only one removes the lock, and only the one it saw.
const reap = (lock: string, observed: string) =>
  Result.gen(async function* () {
    const guard = `${lock}.reap`;
    const made = yield* Result.await(
      io(writeFileExclusive(guard, JSON.stringify({ pid: process.pid }))),
    );
    if (!made) {
      // A reaper that died leaves its guard behind; that alone is cleared.
      if (dead(await heldBy(guard))) yield* Result.await(io(removeFile(guard)));
      return Result.ok(false);
    }
    const now = await heldBy(lock);
    const same = now !== null && now.token === observed && dead(now);
    if (same) yield* Result.await(io(removeFile(lock)));
    yield* Result.await(io(removeFile(guard)));
    return Result.ok(same);
  });

// Held from the first check to the saved state, and failing at once instead of waiting.
export const acquire = (lock: string, holder = "claude run") =>
  Result.gen(async function* () {
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const created = yield* Result.await(
        io(
          writeFileExclusive(
            lock,
            JSON.stringify({
              pid: process.pid,
              token,
              startedAt: new Date().toISOString(),
            }),
          ),
        ),
      );
      if (created) return Result.ok(token);
      const held = await heldBy(lock);
      if (held === null || !dead(held))
        return fail(
          `another ${holder}${typeof held?.pid === "number" ? ` (pid ${held.pid})` : ""} is using this session`,
        );
      const taken = yield* Result.await(reap(lock, String(held.token)));
      if (!taken) return fail(`another ${holder} is taking over this session`);
    }
    return fail(`cannot take ${lock}`);
  });

// Removes only the lock this run took, so a lock another run holds now stays.
export const release = async (lock: string, token: string) => {
  const holder = await heldBy(lock);
  if (holder?.token === token) await removeFile(lock);
};

type Outcome = { sessionId: string | null; isError: boolean; text: string };

const outcomeOf = (stdout: string): Outcome | null => {
  const last = printAnswer(stdout);
  if (last === null || last.type !== "result") return null;
  const id = last.session_id;
  const result = last.result;
  return {
    sessionId: typeof id === "string" && UUID.test(id) ? id : null,
    isError: last.is_error === true || last.subtype !== "success",
    text: typeof result === "string" ? result : asText(result),
  };
};

const recoveryHint = (session: string) =>
  `its result is unknown, so it is never rerun on its own. Check the work it may have done, then rerun with --recover adopt (continue that session) or --recover discard (it did nothing); \`harnexus-task claude --session ${session}\` shows it`;

// Everything from the checks to the saved state runs under the lock.
const locked = (
  args: ClaudeArgs,
  deps: CloudDeps,
  dir: string,
  prompt: string,
) =>
  Result.gen(async function* () {
    const records = yield* Result.await(readRecords(dir));
    const { statePath, pendingPath } = records;
    let { state } = records;
    // The record of an adopted lost turn; a run that sends nothing puts it back.
    let adopted: Fields | null = null;

    const lost = yield* Result.await(
      settlePending(records, args.recover, {
        blocked: (pending) =>
          `a ${asText(pending.mode)} turn of session ${args.session} (${asText(pending.sessionId)}) did not report back: ${recoveryHint(args.session)}`,
        nothingPending: "--recover applies only when a turn is pending",
      }),
    );
    if (lost !== null) {
      if (args.mode !== "resume")
        return fail(
          "--recover adopt continues the session, so use it with --resume",
        );
      // The session the lost turn used becomes the one to resume.
      state = {
        ...(state ?? {}),
        sessionId: lost.sessionId,
        cwd: lost.cwd,
        model: lost.model ?? null,
        permissionMode: lost.permissionMode,
        turns: Number(state?.turns ?? 0),
        history: Array.isArray(state?.history) ? state.history : [],
      };
      // Keep the recovery record until the next turn has passed validation
      // and its pending record is saved. A bad cwd or unavailable binary
      // must not erase the only durable reference to the lost session.
      adopted = lost;
    }

    const resuming = args.mode === "resume";
    if (!resuming && state !== null)
      return fail(
        `session ${args.session} already started as ${asText(state.sessionId)}; use --resume, or another --session name`,
      );
    if (
      resuming &&
      (state === null ||
        typeof state.sessionId !== "string" ||
        !UUID.test(state.sessionId) ||
        typeof state.cwd !== "string")
    )
      return fail(
        `session ${args.session} has no recorded Claude session; use --start`,
      );
    if (resuming && args.cwd !== undefined && args.cwd !== state?.cwd)
      return fail(
        `session ${args.session} runs in ${asText(state?.cwd)}; --cwd cannot change it`,
      );

    const cwd = resuming
      ? String(state?.cwd)
      : (args.cwd ?? deps.cwd ?? process.cwd());
    if (!cwd.startsWith("/") || !(await isDirectory(cwd)))
      return fail(
        `working directory ${cwd} is not an existing absolute directory`,
      );
    const bin = yield* configuredBinary(
      deps.env,
      "HARNEXUS_CLAUDE_CLOUD_BIN",
      CLOUD_CLAUDE_BIN,
    );
    if ((await checkAccess(bin, "execute")).isErr())
      return fail(
        `${bin} is not runnable; run /workspace/.cloud-setup/install.sh in the Cloud task first`,
      );
    const timeoutMs = yield* milliseconds(
      deps.env,
      "HARNEXUS_CLAUDE_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    );
    const killGraceMs = yield* milliseconds(
      deps.env,
      "HARNEXUS_CLAUDE_KILL_GRACE_MS",
      DEFAULT_KILL_GRACE_MS,
    );

    const model =
      args.model ??
      (typeof state?.model === "string" ? state.model : undefined);
    const permissionMode =
      args.permissionMode ??
      (resuming && typeof state?.permissionMode === "string"
        ? state.permissionMode
        : "auto");
    // A start names its session up front, so a turn that is lost can still be found.
    const sessionId = resuming ? String(state?.sessionId) : randomUUID();
    const argv = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      permissionMode,
      ...(model === undefined ? [] : ["--model", model]),
      ...(resuming ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ];

    const record: Fields = {
      mode: args.mode,
      sessionId,
      cwd,
      model: model ?? null,
      permissionMode,
      startedAt: new Date().toISOString(),
    };
    yield* Result.await(
      deps.saveJson(pendingPath, record, { exclusive: false }),
    );
    // Nothing was sent: release this run's record, or restore the adopted one.
    const unsent = async () =>
      adopted === null
        ? io(removeFile(pendingPath))
        : deps.saveJson(pendingPath, adopted, { exclusive: false });
    const ran = await runProcess(bin, argv, prompt, {
      cwd,
      env: deps.env,
      timeoutMs,
      killGraceMs,
    });
    if (ran.isErr()) {
      // Never started: nothing was sent, so the pending record is released.
      if (!ran.error.started) yield* Result.await(unsent());
      return fail(
        ran.error.started
          ? `${ran.error.message}; ${recoveryHint(args.session)}`
          : ran.error.message,
      );
    }
    const { status, stdout, stderr, ended } = ran.value;
    if (ended !== "exit")
      return fail(
        `claude was stopped (${ended === "timeout" ? "timeout" : "output over the limit"}); ${recoveryHint(args.session)}`,
      );
    if (status === NETWORK_EXIT) {
      yield* Result.await(unsent());
      return fail(
        `${detail(stderr)}; nothing was sent, so run it again once the network is allowed`,
      );
    }
    const outcome = outcomeOf(stdout);
    const recorded = outcome?.sessionId ?? null;
    if (recorded === null)
      return fail(
        `claude ended (exit ${status}) without a result carrying a valid session_id${outcome === null ? "" : `: ${detail(outcome.text)}`}; ${recoveryHint(args.session)}`,
      );
    const history = Array.isArray(state?.history) ? state.history : [];
    const saved = await deps.saveJson(
      statePath,
      {
        session: args.session,
        sessionId: recorded,
        cwd,
        model: model ?? null,
        permissionMode,
        turns: Number(state?.turns ?? 0) + 1,
        history: history.at(-1) === recorded ? history : [...history, recorded],
        updatedAt: new Date().toISOString(),
      },
      { exclusive: false },
    );
    // The pending record stays, so a lost state is recovered rather than started over.
    if (saved.isErr())
      return fail(`${saved.error.message}; ${recoveryHint(args.session)}`);
    yield* Result.await(io(removeFile(pendingPath)));
    if (status !== 0 || outcome === null || outcome.isError)
      return fail(
        `claude did not finish the turn (exit ${status}): ${detail(outcome?.text ?? stderr)}; session ${recorded} is recorded, resume it`,
      );
    return Result.ok<Fields>({
      session: args.session,
      sessionId: recorded,
      resumed: resuming,
      cwd,
      permissionMode,
      result: outcome.text,
      state: statePath,
    });
  });

export const claudeSession = (args: ClaudeArgs, deps: CloudDeps) =>
  Result.gen(async function* () {
    yield* singleLine(args.session, "--session");
    if (!KEY.test(args.session))
      return fail(
        "--session may hold letters, digits and _ . : / - (128 characters at most)",
      );
    const dir = directory(deps.env, args.session);
    if (args.mode === "state") {
      const { statePath, state, pending } = yield* Result.await(
        readRecords(dir),
      );
      return Result.ok<Fields>({
        session: args.session,
        sessionId: state === null ? null : state.sessionId,
        ...state,
        pending,
        state: statePath,
      });
    }
    if (args.promptFile === undefined)
      return fail("--prompt-file is required with --start and --resume");
    const prompt = yield* Result.await(readText(args.promptFile));
    if (isBlank(prompt)) return fail("the prompt file is empty");
    yield* Result.await(io(prepareDirectory(dir)));
    const lock = join(dir, "lock.json");
    const token = yield* Result.await(acquire(lock));
    const done = await locked(args, deps, dir, prompt);
    await release(lock, token);
    return done;
  });
