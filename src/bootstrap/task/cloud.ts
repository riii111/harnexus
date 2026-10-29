import { createHash } from "node:crypto";
import { join } from "node:path";
import { Result } from "better-result";
import {
  checkAccess,
  isDirectory,
  prepareDirectory,
  removeFile,
  writeFileExclusive,
} from "../../runtime/fs.boundary.ts";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import { processAlive, runClaude } from "./claude-run.boundary.ts";
import { asText, type Fields, fail, isBlank, TaskFailed } from "./format.ts";
import { type Env, ioFailed, readText, singleLine } from "./request.ts";
import { load, type SaveJson, stateRoot } from "./session.ts";

export const CLOUD_CLAUDE_BIN = "/workspace/.cloud-setup/bin/claude-cloud";
const TIMEOUT_MS = 60 * 60_000;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_.:/-]{0,127}$/u;
const NETWORK_EXIT = 75;

export const PERMISSION_MODES = ["auto", "plan"] as const;

export type ClaudeArgs = {
  mode: "start" | "resume" | "state";
  session: string;
  promptFile?: string;
  model?: string;
  cwd?: string;
  permissionMode: string;
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
  return configured?.startsWith("/") ? configured : CLOUD_CLAUDE_BIN;
};

// Held for the whole turn, so two runs never feed one Claude session at once.
const acquire = (lock: string) =>
  Result.gen(async function* () {
    for (let attempt = 0; attempt < 2; attempt++) {
      const created = yield* Result.await(
        writeFileExclusive(
          lock,
          JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
          }),
        ).then((made) => made.mapError(ioFailed)),
      );
      if (created) return Result.ok();
      const held = yield* Result.await(load(lock));
      const pid = isObject(held) ? held.pid : null;
      if (typeof pid === "number" && processAlive(pid))
        return fail(`another claude run (pid ${pid}) is using this session`);
      yield* Result.await(removeFile(lock).then((r) => r.mapError(ioFailed)));
    }
    return fail(`cannot take ${lock}`);
  });

type Outcome = { sessionId: string | null; isError: boolean; text: string };

// Print mode answers one object, or an array of events ending in it.
const outcomeOf = (stdout: string): Outcome | null => {
  const parsed = parseJson(stdout);
  if (parsed.isErr()) return null;
  const events: unknown[] = Array.isArray(parsed.value)
    ? parsed.value
    : [parsed.value];
  const last = events
    .filter((event) => isObject(event) && event.type === "result")
    .at(-1);
  if (!isObject(last)) return null;
  const id = last.session_id;
  const result = last.result;
  return {
    sessionId: typeof id === "string" && SESSION_ID.test(id) ? id : null,
    isError: last.is_error === true || last.subtype !== "success",
    text: typeof result === "string" ? result : asText(result),
  };
};

const detail = (text: string) => text.trim().slice(0, 500);

const turn = (
  args: ClaudeArgs,
  deps: CloudDeps,
  dir: string,
  state: Fields | null,
) =>
  Result.gen(async function* () {
    const resuming = args.mode === "resume";
    const cwd = resuming
      ? String(state?.cwd)
      : (args.cwd ?? deps.cwd ?? process.cwd());
    if (!cwd.startsWith("/") || !(await isDirectory(cwd)))
      return fail(
        `working directory ${cwd} is not an existing absolute directory`,
      );
    const bin = binary(deps.env);
    const runnable = await checkAccess(bin, "execute");
    if (runnable.isErr())
      return fail(
        `${bin} is not runnable; run /workspace/.cloud-setup/install.sh in the Cloud task first`,
      );
    const prompt = yield* Result.await(readText(args.promptFile ?? ""));
    if (isBlank(prompt)) return fail("the prompt file is empty");
    const model =
      args.model ??
      (typeof state?.model === "string" ? state.model : undefined);
    const argv = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      args.permissionMode,
      ...(model === undefined ? [] : ["--model", model]),
      ...(resuming ? ["--resume", String(state?.sessionId)] : []),
    ];
    const lock = join(dir, "lock.json");
    yield* Result.await(
      prepareDirectory(dir).then((made) => made.mapError(ioFailed)),
    );
    yield* Result.await(acquire(lock));
    const ran = await runClaude(bin, argv, prompt, {
      cwd,
      env: deps.env,
      timeoutMs: TIMEOUT_MS,
    });
    await removeFile(lock);
    if (ran.isErr())
      return Result.err(new TaskFailed({ message: ran.error.message }));
    const { status, stdout, stderr } = ran.value;
    if (status === NETWORK_EXIT)
      return fail(
        `${detail(stderr)}; nothing was sent, so run it again once the network is allowed`,
      );
    const outcome = outcomeOf(stdout);
    const recorded = outcome?.sessionId ?? null;
    // A started session is kept even when its turn failed, so the next call resumes it instead of starting over.
    if (recorded !== null) {
      const history = Array.isArray(state?.history) ? state.history : [];
      yield* Result.await(
        deps.saveJson(
          join(dir, "state.json"),
          {
            session: args.session,
            sessionId: recorded,
            cwd,
            model: model ?? null,
            permissionMode: args.permissionMode,
            turns: Number(state?.turns ?? 0) + 1,
            history:
              history.at(-1) === recorded ? history : [...history, recorded],
            updatedAt: new Date().toISOString(),
          },
          { exclusive: false },
        ),
      );
    }
    if (status !== 0 || outcome === null || outcome.isError)
      return fail(
        `claude did not finish the turn (exit ${status}${outcome === null ? ", no result in its output" : ""}): ` +
          `${detail(outcome?.text ?? stderr)}` +
          (recorded === null
            ? ""
            : `; session ${recorded} is recorded, resume it`),
      );
    if (recorded === null)
      return fail(
        "claude's result carried no valid session_id, so nothing was recorded",
      );
    return Result.ok<Fields>({
      session: args.session,
      sessionId: recorded,
      resumed: resuming,
      cwd,
      result: outcome.text,
      state: join(dir, "state.json"),
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
    const loaded = yield* Result.await(load(join(dir, "state.json")));
    const state = isObject(loaded) ? loaded : null;
    if (args.mode === "state")
      return Result.ok<Fields>(
        state === null
          ? { session: args.session, sessionId: null }
          : { ...state, state: join(dir, "state.json") },
      );
    if (args.promptFile === undefined)
      return fail("--prompt-file is required with --start and --resume");
    if (args.mode === "start" && state !== null)
      return fail(
        `session ${args.session} already started as ${asText(state.sessionId)}; use --resume, or another --session name`,
      );
    if (args.mode === "resume") {
      if (
        state === null ||
        typeof state.sessionId !== "string" ||
        !SESSION_ID.test(state.sessionId) ||
        typeof state.cwd !== "string"
      )
        return fail(
          `session ${args.session} has no recorded Claude session; use --start`,
        );
      if (args.cwd !== undefined && args.cwd !== state.cwd)
        return fail(
          `session ${args.session} runs in ${asText(state.cwd)}; --cwd cannot change it`,
        );
    }
    return await turn(args, deps, dir, state);
  });
