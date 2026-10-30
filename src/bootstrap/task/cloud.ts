import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Result } from "better-result";
import { printAnswer, UUID } from "../../infra/claude/print.ts";
import { processAlive, runClaude } from "../../infra/claude/run.boundary.ts";
import {
  checkAccess,
  isDirectory,
  prepareDirectory,
  removeFile,
  writeFileExclusive,
} from "../../runtime/fs.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import { asText, type Fields, fail, isBlank } from "./format.ts";
import { type Env, ioFailed, readText, singleLine } from "./request.ts";
import { load, type SaveJson, stateRoot } from "./session.ts";

export const CLOUD_CLAUDE_BIN = "/workspace/.cloud-setup/bin/claude-cloud";
const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_.:/-]{0,127}$/u;
const NETWORK_EXIT = 75;

export const PERMISSION_MODES = ["auto", "plan"] as const;
export const RECOVERIES = ["adopt", "discard"] as const;

export type ClaudeArgs = {
  mode: "start" | "resume" | "state";
  session: string;
  promptFile?: string;
  model?: string;
  cwd?: string;
  // Absent on a resume keeps the mode the session has; absent on a start means auto.
  permissionMode?: string;
  recover?: string;
};

export type CloudDeps = { env: Env; saveJson: SaveJson; cwd?: string };

const directory = (env: Env, key: string) =>
  join(
    stateRoot(env),
    "cloud-claude",
    createHash("sha256").update(key).digest("hex").slice(0, 16),
  );

const binary = (env: Env) => {
  const configured = env.HARNEXUS_CLAUDE_CLOUD_BIN;
  if (configured === undefined || configured === "")
    return Result.ok(CLOUD_CLAUDE_BIN);
  return configured.startsWith("/")
    ? Result.ok(configured)
    : fail("HARNEXUS_CLAUDE_CLOUD_BIN must be an absolute path");
};

const milliseconds = (env: Env, name: string, fallback: number) => {
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
      writeFileExclusive(guard, JSON.stringify({ pid: process.pid })).then(
        (r) => r.mapError(ioFailed),
      ),
    );
    if (!made) {
      // A reaper that died leaves its guard behind; that alone is cleared.
      if (dead(await heldBy(guard)))
        yield* Result.await(
          removeFile(guard).then((r) => r.mapError(ioFailed)),
        );
      return Result.ok(false);
    }
    const now = await heldBy(lock);
    const same = now !== null && now.token === observed && dead(now);
    if (same)
      yield* Result.await(removeFile(lock).then((r) => r.mapError(ioFailed)));
    yield* Result.await(removeFile(guard).then((r) => r.mapError(ioFailed)));
    return Result.ok(same);
  });

// Held from the first check to the saved state, and failing at once instead of waiting.
const acquire = (lock: string) =>
  Result.gen(async function* () {
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const created = yield* Result.await(
        writeFileExclusive(
          lock,
          JSON.stringify({
            pid: process.pid,
            token,
            startedAt: new Date().toISOString(),
          }),
        ).then((made) => made.mapError(ioFailed)),
      );
      if (created) return Result.ok(token);
      const holder = await heldBy(lock);
      if (holder === null || !dead(holder))
        return fail(
          `another claude run${typeof holder?.pid === "number" ? ` (pid ${holder.pid})` : ""} is using this session`,
        );
      const taken = yield* Result.await(reap(lock, String(holder.token)));
      if (!taken) return fail("another claude run is taking over this session");
    }
    return fail(`cannot take ${lock}`);
  });

// Removes only the lock this run took, so a lock another run holds now stays.
const release = async (lock: string, token: string) => {
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

const detail = (text: string) => text.trim().slice(0, 500);

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
    const statePath = join(dir, "state.json");
    const pendingPath = join(dir, "pending.json");
    const loaded = yield* Result.await(load(statePath));
    let state = isObject(loaded) ? loaded : null;
    const pendingLoaded = yield* Result.await(load(pendingPath));
    let pending = isObject(pendingLoaded) ? pendingLoaded : null;
    // The record of an adopted lost turn; a run that sends nothing puts it back.
    let adopted: Fields | null = null;

    if (pending !== null) {
      if (args.recover === undefined)
        return fail(
          `a ${asText(pending.mode)} turn of session ${args.session} (${asText(pending.sessionId)}) did not report back: ${recoveryHint(args.session)}`,
        );
      if (args.recover === "discard") {
        yield* Result.await(
          removeFile(pendingPath).then((r) => r.mapError(ioFailed)),
        );
        pending = null;
      } else {
        if (args.mode !== "resume")
          return fail(
            "--recover adopt continues the session, so use it with --resume",
          );
        // The session the lost turn used becomes the one to resume.
        state = {
          ...(state ?? {}),
          sessionId: pending.sessionId,
          cwd: pending.cwd,
          model: pending.model ?? null,
          permissionMode: pending.permissionMode,
          turns: Number(state?.turns ?? 0),
          history: Array.isArray(state?.history) ? state.history : [],
        };
        // Keep the recovery record until the next turn has passed validation
        // and its pending record is saved. A bad cwd or unavailable binary
        // must not erase the only durable reference to the lost session.
        adopted = pending;
        pending = null;
      }
    } else if (args.recover !== undefined) {
      return fail("--recover applies only when a turn is pending");
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
    const bin = yield* binary(deps.env);
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
        ? removeFile(pendingPath).then((r) => r.mapError(ioFailed))
        : deps.saveJson(pendingPath, adopted, { exclusive: false });
    const ran = await runClaude(bin, argv, prompt, {
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
    yield* Result.await(
      removeFile(pendingPath).then((r) => r.mapError(ioFailed)),
    );
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
      const loaded = yield* Result.await(load(join(dir, "state.json")));
      const pending = yield* Result.await(load(join(dir, "pending.json")));
      return Result.ok<Fields>({
        session: args.session,
        sessionId: isObject(loaded) ? loaded.sessionId : null,
        ...(isObject(loaded) ? loaded : {}),
        pending: isObject(pending) ? pending : null,
        state: join(dir, "state.json"),
      });
    }
    if (args.promptFile === undefined)
      return fail("--prompt-file is required with --start and --resume");
    const prompt = yield* Result.await(readText(args.promptFile));
    if (isBlank(prompt)) return fail("the prompt file is empty");
    yield* Result.await(
      prepareDirectory(dir).then((made) => made.mapError(ioFailed)),
    );
    const lock = join(dir, "lock.json");
    const token = yield* Result.await(acquire(lock));
    const done = await locked(args, deps, dir, prompt);
    await release(lock, token);
    return done;
  });
