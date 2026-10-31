import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Result } from "better-result";
import {
  prepareDirectory,
  readTextFileIfExists,
  removeFile,
  writeFileAtomic,
  writeFileExclusive,
} from "../runtime/fs.boundary.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { type Fields, isObject } from "../runtime/object.ts";
import { fail, TaskFailed, truthy } from "./format.ts";
import { absoluteOr, type Env, homeOf, io, NAME } from "./request.ts";

export const RECOVERIES = ["adopt", "discard"] as const;

export type Recovery = (typeof RECOVERIES)[number];

export type SaveJson = (
  path: string,
  data: unknown,
  options: { exclusive: boolean },
) => Promise<Result<void, TaskFailed>>;

type Records = {
  statePath: string;
  pendingPath: string;
  // As read, so a later read can tell whether another run wrote the file in between.
  loaded: unknown;
  state: Fields | null;
  pending: Fields | null;
};

// state.json holds what was confirmed; pending.json holds a send whose result is unknown and blocks any resend.
export const readRecords = (directory: string) =>
  Result.gen(async function* () {
    const statePath = join(directory, "state.json");
    const pendingPath = join(directory, "pending.json");
    const loaded = yield* Result.await(load(statePath));
    const state = yield* asRecord(loaded, statePath);
    const pendingLoaded = yield* Result.await(load(pendingPath));
    const pending = yield* asRecord(pendingLoaded, pendingPath);
    return Result.ok<Records>({
      statePath,
      pendingPath,
      loaded,
      state,
      pending,
    });
  });

// Settles a pending send by the user's recovery flag: discard removes the record, and adopt returns it for the caller to continue from.
export const settlePending = (
  { pending, pendingPath }: Pick<Records, "pending" | "pendingPath">,
  recover: Recovery | undefined,
  messages: { blocked: (pending: Fields) => string; nothingPending: string },
) =>
  Result.gen(async function* () {
    if (pending === null)
      return recover === undefined
        ? Result.ok<Fields | null>(null)
        : fail(messages.nothingPending);
    // Only the user, having checked what the lost send did, releases it.
    if (recover === undefined) return fail(messages.blocked(pending));
    if (recover === "discard") {
      yield* Result.await(removeRecord(pendingPath));
      return Result.ok<Fields | null>(null);
    }
    return Result.ok<Fields | null>(pending);
  });

const asRecord = (value: unknown, path: string) =>
  !truthy(value)
    ? Result.ok(null)
    : isObject(value)
      ? Result.ok(value)
      : fail(`${path} does not hold a JSON object`);

export const saveJson: SaveJson = (path, data, { exclusive }) =>
  Result.gen(async function* () {
    yield* Result.await(io(prepareDirectory(dirname(path))));
    // Indented by one space like the Python taskctl, so the files read alike in either version.
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

export const load = (path: string) =>
  Result.gen(async function* () {
    const text = yield* Result.await(io(readTextFileIfExists(path)));
    if (text === null) return Result.ok(null);
    return parseJson(text).mapError(
      () => new TaskFailed({ message: `${path} is not valid JSON` }),
    );
  });

export const removeRecord = (path: string) => io(removeFile(path));

export const stateRoot = (env: Env) =>
  join(
    absoluteOr(env.XDG_STATE_HOME, join(homeOf(env), ".local/state")),
    "taskctl",
  );

export const stateDirectory = (env: Env, kind: string, key: string) =>
  join(
    stateRoot(env),
    kind,
    // Each kind lays out its own key, since changing one would lose the directories already recorded under it.
    createHash("sha256").update(key).digest("hex").slice(0, 16),
  );
