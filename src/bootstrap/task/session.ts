import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Result } from "better-result";
import type { CallOutcome } from "../../infra/codex/call-gateway.ts";
import { loadCallerSocketPath } from "../../runtime/config.ts";
import {
  entryExists,
  isDirectory,
  isSymlink,
  listDirectoryIfExists,
  prepareDirectory,
  readTextFileIfExists,
  realPathOrSelf,
  removeFile,
  writeFileAtomic,
  writeFileExclusive,
} from "../../runtime/fs.boundary.ts";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import { requestLine } from "../../runtime/socket.boundary.ts";
import {
  asText,
  type Fields,
  fail,
  jsonEqual,
  TaskFailed,
  truthy,
} from "./format.ts";
import {
  absoluteOr,
  chatId,
  type Env,
  homeOf,
  ioFailed,
  NAME,
  readJson,
} from "./request.ts";

const CALL_TIMEOUT_MS = 15 * 60_000;
const SOCKET_HINT = `the socket is closed only when the app was opened with HARNEXUS_CALL_SOCKET=off, so open it with bun run open-app and run ${NAME} outside the sandbox`;

const NOT_SENT: readonly CallOutcome[] = ["not_sent", "rejected", "invalid"];

export type SaveJson = (
  path: string,
  data: unknown,
  options: { exclusive: boolean },
) => Promise<Result<void, TaskFailed>>;

const io = async <T>(
  pending: Promise<Result<T, { message: string; cause?: unknown }>>,
): Promise<Result<T, TaskFailed>> => (await pending).mapError(ioFailed);

// Indented by one space like the Python taskctl, so the files read alike in either version.
export const saveJson: SaveJson = (path, data, { exclusive }) =>
  Result.gen(async function* () {
    yield* Result.await(io(prepareDirectory(dirname(path))));
    const content = JSON.stringify(data, null, 1);
    if (!exclusive) {
      yield* Result.await(io(writeFileAtomic(path, content)));
      return Result.ok();
    }
    const created = yield* Result.await(io(writeFileExclusive(path, content)));
    return created
      ? Result.ok()
      : fail(`another ${NAME} run is sending; inspect ${path}`);
  });

const load = (path: string) =>
  Result.gen(async function* () {
    const text = yield* Result.await(io(readTextFileIfExists(path)));
    if (text === null) return Result.ok(null);
    return parseJson(text).mapError(
      () => new TaskFailed({ message: `${path} is not valid JSON` }),
    );
  });

const remove = (path: string) => io(removeFile(path));

export const callApp = async (
  env: Env,
  caller: string,
  tool: string,
  args: Fields,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<Fields> => {
  const path = loadCallerSocketPath(env, () => homeOf(env));
  if (path.isErr())
    return {
      outcome: "not_sent",
      error: `${path.error.message}; ${SOCKET_HINT}`,
    };
  const line = JSON.stringify({ threadId: caller, tool, arguments: args });
  const answer = await requestLine(path.value, line, timeoutMs);
  if (answer.isErr()) {
    const reason = answer.error.code ?? answer.error.message;
    // The request may already have reached the App once connected.
    return answer.error.connected
      ? { outcome: "unknown", error: `no answer: ${reason}` }
      : {
          outcome: "not_sent",
          error: `${path.value}: ${reason}; ${SOCKET_HINT}`,
        };
  }
  const parsed = parseJson(answer.value);
  if (parsed.isErr())
    return { outcome: "unknown", error: "no answer: invalid JSON" };
  if (!isObject(parsed.value) || !Object.hasOwn(parsed.value, "outcome"))
    return { outcome: "unknown", error: "no answer: answer without outcome" };
  return parsed.value;
};

export type SessionDeps = { env: Env; saveJson: SaveJson };

type Confirmed = (
  thread: string,
  pending: Fields,
  sent: Fields,
  state: Fields | null,
) => Result<Fields, TaskFailed>;

// The kind and thread fields of a session's state summary, read from its confirmed state and pending send.
type Summarize = (state: Fields | null, pending: Fields | null) => Fields;

const field = (record: unknown, key: string) =>
  isObject(record) ? (record[key] ?? null) : null;

const settingsOf = (record: unknown) => ({
  model: field(record, "model"),
  effort: field(record, "effort"),
});

const asRecord = (value: unknown, path: string) =>
  !truthy(value)
    ? Result.ok(null)
    : isObject(value)
      ? Result.ok(value)
      : fail(`${path} does not hold a JSON object`);

// state.json holds the confirmed thread; pending.json blocks any resend.
const openSession = (
  directory: string,
  confirmed: Confirmed,
  summarize: Summarize,
  deps: SessionDeps,
  legacy?: () => Promise<Result<Fields | null, TaskFailed>>,
) =>
  Result.gen(async function* () {
    const statePath = join(directory, "state.json");
    const pendingPath = join(directory, "pending.json");
    const historyPath = join(directory, "history.json");
    const loaded = yield* Result.await(load(statePath));
    const state = truthy(loaded)
      ? yield* asRecord(loaded, statePath)
      : legacy === undefined
        ? null
        : yield* Result.await(legacy());
    const pendingLoaded = yield* Result.await(load(pendingPath));
    let pending = yield* asRecord(pendingLoaded, pendingPath);
    const save = deps.saveJson;

    const checkIdle = (): Result<void, TaskFailed> => {
      if (pending === null) return Result.ok();
      if (pending.status === "refused")
        return fail(
          `thread ${asText(pending.threadId)} refused its first turn: expected ${asText(pending.expected)}, ` +
            `actual ${asText(pending.actual)}; fix the model, then resolve --not-sent`,
        );
      return fail(
        `previous ${asText(pending.tool)} ended as ${asText(pending.status)}; never resend. ` +
          "Ask the user to check the App, then run resolve --sent or --not-sent",
      );
    };

    const confirm = (record: Fields, thread: unknown, answer: Fields | null) =>
      Result.gen(async function* () {
        if (!truthy(thread))
          return fail(
            "thread ID is unknown; check the App, then resolve --sent --thread-id",
          );
        const args = isObject(record.arguments) ? record.arguments : {};
        const sent = {
          tool: record.tool ?? null,
          prompt: args.prompt ?? null,
          expected: {
            model: args.model ?? null,
            effort: args.thinking ?? null,
          },
          actual: {
            model: answer?.model ?? null,
            effort: answer?.effort ?? null,
          },
          workspace: record.workspace ?? null,
          answer,
        };
        const id = yield* chatId(thread, "threadId");
        const next = yield* confirmed(id, record, sent, state);
        yield* Result.await(save(statePath, next, { exclusive: false }));
        yield* Result.await(remove(pendingPath));
        // A message to an existing thread that asked for no model or effort learns neither, so nulls would only mislead.
        const unasked =
          sent.tool === "send_message_to_thread" &&
          args.model === undefined &&
          args.thinking === undefined;
        return Result.ok({
          tool: sent.tool,
          threadId: thread,
          ...(!unasked && { ...sent.actual, expected: sent.expected }),
          state: statePath,
        });
      });

    const send = (caller: string, tool: string, args: Fields, extra: Fields) =>
      Result.gen(async function* () {
        yield* checkIdle();
        const record: Fields = {
          status: "sending",
          tool,
          arguments: args,
          ...extra,
        };
        yield* Result.await(save(pendingPath, record, { exclusive: true }));
        if (!jsonEqual(yield* Result.await(load(statePath)), loaded)) {
          yield* Result.await(remove(pendingPath));
          return fail(
            `another ${NAME} run changed the state; rerun to check it`,
          );
        }
        const answer = await callApp(deps.env, caller, tool, args);
        const outcome = answer.outcome;
        const thread = truthy(answer.threadId)
          ? answer.threadId
          : (args.threadId ?? null);
        if (outcome === ("done" satisfies CallOutcome)) {
          const confirmed = await confirm(record, thread, answer);
          // The thread exists, so a failed record is kept for resolve rather than released.
          if (confirmed.isErr()) {
            Object.assign(record, {
              status: "unknown",
              threadId: thread,
              answer,
            });
            yield* Result.await(
              save(pendingPath, record, { exclusive: false }),
            );
          }
          return confirmed;
        }
        if (outcome === ("model_mismatch" satisfies CallOutcome)) {
          Object.assign(record, {
            status: "refused",
            threadId: thread,
            answer,
            expected: answer.expected ?? null,
            actual: answer.actual ?? null,
          });
          yield* Result.await(save(pendingPath, record, { exclusive: false }));
          pending = record;
          yield* checkIdle();
        }
        const text = JSON.stringify(answer);
        // A lost send_message answer reaches Claude callers as tool_error.
        if (
          (NOT_SENT as readonly unknown[]).includes(outcome) ||
          (outcome === ("tool_error" satisfies CallOutcome) &&
            tool === "create_thread" &&
            !truthy(answer.threadId))
        ) {
          yield* Result.await(remove(pendingPath));
          return fail(`${tool} was not sent: ${text}`);
        }
        Object.assign(record, { status: "unknown", threadId: thread, answer });
        yield* Result.await(save(pendingPath, record, { exclusive: false }));
        return fail(
          `${tool} result is unknown (${text}); never resend. Ask the user to check the App`,
        );
      });

    const resolve = (sent: boolean, thread: string | null) =>
      Result.gen(async function* () {
        if (pending === null) return fail("nothing is pending");
        if (!sent) {
          if (pending.status === "refused") {
            const history = yield* Result.await(load(historyPath));
            const kept = Array.isArray(history) ? history : [];
            yield* Result.await(
              save(historyPath, [...kept, pending], { exclusive: false }),
            );
          }
          yield* Result.await(remove(pendingPath));
          return Result.ok({
            released: pending.tool ?? null,
            status: pending.status ?? null,
          });
        }
        if (pending.status === "refused")
          return fail("a refused first turn never ran; use --not-sent");
        return await confirm(
          pending,
          truthy(thread) ? thread : (pending.threadId ?? null),
          null,
        );
      });

    // Flat fields only, with null for anything unknown, so a reader never has to guess where a value is nested.
    const show = () =>
      Result.gen(async function* () {
        const refused = yield* Result.await(load(historyPath));
        const sent = field(state, "sent");
        return Result.ok<Fields>({
          ...summarize(state, pending),
          requested: settingsOf(field(sent, "expected")),
          actual: settingsOf(field(sent, "actual")),
          pending: field(pending, "status"),
          statePath,
          prompt: field(sent, "prompt"),
          refusedThreadIds: (Array.isArray(refused) ? refused : []).map(
            (record) => field(record, "threadId"),
          ),
        });
      });

    return Result.ok({ statePath, state, checkIdle, send, resolve, show });
  });

export const stateRoot = (env: Env) =>
  join(
    absoluteOr(env.XDG_STATE_HOME, join(homeOf(env), ".local/state")),
    "taskctl",
  );

const sessionDir = (env: Env, kind: string, ...values: string[]) =>
  join(
    stateRoot(env),
    kind,
    createHash("sha256").update(values.join("\n")).digest("hex").slice(0, 16),
  );

export const launchSession = (data: Fields, deps: SessionDeps) =>
  openSession(
    sessionDir(deps.env, "launch", String(data.projectId), String(data.taskId)),
    (thread, pending, sent) =>
      Result.ok({ threadId: thread, request: pending.request ?? null, sent }),
    (state) => ({
      kind: "launch",
      // The session is kept per task, so its request names the task before anything was sent.
      taskId: data.taskId ?? null,
      workerThreadId: field(state, "threadId"),
    }),
    deps,
  );

export const reviewSession = (data: Fields, deps: SessionDeps) =>
  openSession(
    sessionDir(
      deps.env,
      "review",
      String(data.checkout),
      String(data.workerChatId),
    ),
    (thread, pending, sent, state) => {
      if (state !== null && !jsonEqual(state.reviewer, thread))
        return fail("review session must keep the same reviewer");
      const candidate = isObject(pending.candidate) ? pending.candidate : {};
      if (thread === candidate.workerChatId)
        return fail("a worker cannot review itself");
      return Result.ok({
        reviewer: thread,
        candidate: pending.candidate ?? null,
        sent,
      });
    },
    (state, pending) => {
      const recorded = field(state, "candidate");
      // A pending send carries the newest candidate, which the recorded one follows once it is confirmed.
      const latest = field(pending, "candidate") ?? recorded;
      return {
        kind: "review",
        reviewerThreadId: field(state, "reviewer"),
        workerThreadId:
          field(latest, "workerChatId") ?? data.workerChatId ?? null,
        base: field(latest, "base"),
        head: field(latest, "head"),
        baseBranch: field(latest, "baseBranch"),
        prUrl: field(latest, "prUrl"),
        lastSentHead: field(recorded, "head"),
      };
    },
    deps,
    () => legacyReviewState(String(data.checkout)),
  );

const legacyReviewState = (checkout: string) =>
  Result.gen(async function* () {
    const path = join(checkout, ".reviewctl/state.json");
    if (!(await entryExists(path))) return Result.ok(null);
    if ((await isSymlink(path)) || (await realPathOrSelf(path)) !== path)
      return fail(`refusing symlinked legacy state ${path}`);
    const state = yield* Result.await(readJson(path));
    if (!isObject(state)) return fail(`${path} does not hold a JSON object`);
    if (state.pending_create === true || !truthy(state.reviewer))
      return fail(
        `legacy reviewctl creation is pending in ${path}; check the App, ` +
          "and remove it only if no reviewer was created",
      );
    return Result.ok<Fields | null>({
      reviewer: state.reviewer,
      candidate: state.candidate ?? null,
    });
  });

export const listState = (env: Env) =>
  Result.gen(async function* () {
    const root = stateRoot(env);
    const paths: string[] = [];
    if (await isDirectory(root)) {
      for (const kind of yield* Result.await(namesIn(root))) {
        const kindPath = join(root, kind);
        if (!(await isDirectory(kindPath))) continue;
        for (const key of yield* Result.await(namesIn(kindPath))) {
          const keyPath = join(kindPath, key);
          if (!(await isDirectory(keyPath))) continue;
          for (const name of yield* Result.await(namesIn(keyPath))) {
            if (name.endsWith(".json")) paths.push(join(keyPath, name));
          }
        }
      }
    }
    const listed: Fields = {};
    for (const path of paths.sort()) {
      listed[path] = yield* Result.await(load(path));
    }
    return Result.ok(listed);
  });

const namesIn = async (path: string) =>
  (await io(listDirectoryIfExists(path))).map((names) => names ?? []);
