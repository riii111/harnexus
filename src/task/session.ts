import { join } from "node:path";
import { Result } from "better-result";
import type { CallOutcome } from "../infra/codex/call-gateway.ts";
import { refusalOf, type TurnSettings } from "../infra/codex/delegations.ts";
import { loadCallerSocketPath } from "../runtime/config.ts";
import {
  isDirectory,
  listDirectoryIfExists,
  realPathOrSelf,
} from "../runtime/fs.boundary.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { type Fields, isObject } from "../runtime/object.ts";
import { requestLine } from "../runtime/socket.boundary.ts";
import { asText, fail, jsonEqual, type TaskFailed, truthy } from "./format.ts";
import {
  load,
  readRecords,
  removeRecord,
  type SaveJson,
  stateDirectory,
  stateRoot,
} from "./records.ts";
import { chatId, type Env, homeOf, io, NAME } from "./request.ts";

const CALL_TIMEOUT_MS = 15 * 60_000;
const SOCKET_HINT = `open the app with bun run open-app without HARNEXUS_CALL_SOCKET=off and run ${NAME} outside the sandbox`;

const socketHint = (code: string | null) => {
  switch (code) {
    case "ENOENT":
      return `no bridge has opened the socket; ${SOCKET_HINT}`;
    case "ECONNREFUSED":
      return "a bridge that has exited left the socket; the running bridge takes it over within seconds, so run again, and reopen the app with bun run open-app if it persists";
    case "EPERM":
    case "EACCES":
      return `the sandbox blocked the connection; run ${NAME} outside the sandbox`;
    default:
      return SOCKET_HINT;
  }
};

const NOT_SENT: readonly CallOutcome[] = ["not_sent", "rejected", "invalid"];

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
          error: `${path.value}: ${reason}; ${socketHint(answer.error.code)}`,
        };
  }
  const parsed = parseJson(answer.value);
  if (parsed.isErr())
    return { outcome: "unknown", error: "no answer: invalid JSON" };
  if (!isObject(parsed.value) || !Object.hasOwn(parsed.value, "outcome"))
    return { outcome: "unknown", error: "no answer: answer without outcome" };
  return parsed.value;
};

export const projectsIn = (result: unknown): unknown[] => {
  if (!isObject(result)) return [];
  const texts = Array.isArray(result.content)
    ? result.content.flatMap((item) =>
        isObject(item) && item.type === "text" && typeof item.text === "string"
          ? [parseJson(item.text).unwrapOr(null)]
          : [],
      )
    : [];
  for (const listed of [result.structuredContent, result, ...texts])
    if (isObject(listed) && Array.isArray(listed.projects))
      return listed.projects;
  return [];
};

// A reviewer reads the worker's checkout by its path, so it runs in an empty project rather than a worktree of its own that counts toward the app's worktree limit.
export const reviewProject = async (
  env: Env,
  caller: string,
): Promise<Result<string, TaskFailed>> => {
  const home = await realPathOrSelf(join(homeOf(env), "review-home"));
  const answer = await callApp(env, caller, "list_projects", {});
  if (answer.outcome !== ("done" satisfies CallOutcome))
    return fail(`list_projects failed: ${JSON.stringify(answer)}`);
  for (const project of projectsIn(answer.result)) {
    if (!isObject(project)) continue;
    const { path, projectId } = project;
    if (typeof path !== "string" || typeof projectId !== "string") continue;
    if ((await realPathOrSelf(path)) === home) return Result.ok(projectId);
  }
  return fail(
    `add ${home} to the Codex app as a project, so reviewers run there instead of in a worktree of their own`,
  );
};

export type SessionDeps = { env: Env; saveJson: SaveJson };

type Confirmed = (
  thread: string,
  pending: Fields,
  sent: Fields,
  state: Fields | null,
) => Result<Fields, TaskFailed>;

type Summarize = (state: Fields | null, pending: Fields | null) => Fields;

const field = (record: unknown, key: string) =>
  isObject(record) ? (record[key] ?? null) : null;

const settingsOf = (record: unknown) => ({
  model: field(record, "model"),
  effort: field(record, "effort"),
});

// A thread runs on what its create asked and got until a later send names a model or thinking, so a send naming neither leaves its settings as they were.
const sentSettings = (sent: unknown) => {
  const expected = settingsOf(field(sent, "expected"));
  return field(sent, "tool") === "create_thread" ||
    expected.model !== null ||
    expected.effort !== null
    ? { requested: expected, actual: settingsOf(field(sent, "actual")) }
    : null;
};

const checkedOf = (settings: Fields): TurnSettings => ({
  model: typeof settings.model === "string" ? settings.model : null,
  effort: typeof settings.effort === "string" ? settings.effort : null,
});

// The app answers a refusal with the settings it checked; anything else is shown as it came.
const refusalText = (expected: unknown, actual: unknown) =>
  isObject(expected) && isObject(actual)
    ? refusalOf(checkedOf(expected), checkedOf(actual))
    : `expected ${asText(expected)}, actual ${asText(actual)}`;

const openSession = (
  directory: string,
  confirmed: Confirmed,
  summarize: Summarize,
  deps: SessionDeps,
) =>
  Result.gen(async function* () {
    const historyPath = join(directory, "history.json");
    const records = yield* Result.await(readRecords(directory));
    const { statePath, pendingPath, loaded, state } = records;
    let { pending } = records;
    const save = deps.saveJson;

    const checkIdle = (): Result<void, TaskFailed> => {
      if (pending === null) return Result.ok();
      if (pending.status === "refused")
        return fail(
          truthy(pending.reason)
            ? `the bridge refused the first turn of thread ${asText(pending.threadId)}: ${asText(pending.reason)}; ` +
                "fix the cause, then resolve --not-sent"
            : `thread ${asText(pending.threadId)} refused its first turn: ${refusalText(pending.expected, pending.actual)}; ` +
                "fix the model, then resolve --not-sent",
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
        yield* Result.await(removeRecord(pendingPath));
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
          yield* Result.await(removeRecord(pendingPath));
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
        // Either way the thread exists but never ran, so it is kept for resolve rather than sent again.
        const refusal =
          outcome === ("model_mismatch" satisfies CallOutcome)
            ? {
                expected: answer.expected ?? null,
                actual: answer.actual ?? null,
              }
            : outcome === ("first_turn_refused" satisfies CallOutcome)
              ? { reason: answer.reason ?? null }
              : null;
        if (refusal !== null) {
          Object.assign(record, {
            status: "refused",
            threadId: thread,
            answer,
            ...refusal,
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
          yield* Result.await(removeRecord(pendingPath));
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
          yield* Result.await(removeRecord(pendingPath));
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
        // A state saved before settings were kept still holds them in its create.
        const settings = field(state, "settings") ?? sentSettings(sent);
        return Result.ok<Fields>({
          ...summarize(state, pending),
          requested: settingsOf(field(settings, "requested")),
          actual: settingsOf(field(settings, "actual")),
          pending: field(pending, "status"),
          pendingThreadId: field(pending, "threadId"),
          statePath,
          prompt: field(sent, "prompt"),
          refusedThreadIds: (Array.isArray(refused) ? refused : []).map(
            (record) => field(record, "threadId"),
          ),
        });
      });

    return Result.ok({ statePath, state, checkIdle, send, resolve, show });
  });

const sessionDir = (env: Env, kind: string, ...values: string[]) =>
  stateDirectory(env, kind, values.join("\n"));

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
        settings:
          sentSettings(sent) ??
          field(state, "settings") ??
          sentSettings(field(state, "sent")),
      });
    },
    (state, pending) => {
      const candidate = field(state, "candidate");
      return {
        kind: "review",
        reviewerThreadId: field(state, "reviewer"),
        workerThreadId:
          field(candidate, "workerChatId") ?? data.workerChatId ?? null,
        base: field(candidate, "base"),
        head: field(candidate, "head"),
        baseBranch: field(candidate, "baseBranch"),
        prUrl: field(candidate, "prUrl"),
        pendingHead: field(field(pending, "candidate"), "head"),
      };
    },
    deps,
  );

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

// The worker learns its own launch from the thread it runs in, since it is never told the request's path.
// Another task's unreadable state is skipped, so it cannot stop every worker from finding its own.
export const launchOfThread = (env: Env, thread: string) =>
  Result.gen(async function* () {
    const root = join(stateRoot(env), "launch");
    for (const key of (yield* Result.await(namesIn(root))).sort()) {
      if (!(await isDirectory(join(root, key)))) continue;
      const loaded = await load(join(root, key, "state.json"));
      const state = loaded.isOk() ? loaded.value : null;
      if (
        isObject(state) &&
        state.threadId === thread &&
        isObject(state.request)
      )
        return Result.ok<Fields | null>(state.request);
    }
    return Result.ok<Fields | null>(null);
  });

export const namesIn = async (path: string) =>
  (await io(listDirectoryIfExists(path))).map((names) => names ?? []);
