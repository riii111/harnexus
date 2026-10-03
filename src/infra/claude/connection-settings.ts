import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { Result, TaggedError } from "better-result";
import { readTextFileIfExists } from "../../runtime/fs.boundary.ts";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import { readCommandOutput } from "../../runtime/process.boundary.ts";
import {
  type Connection,
  type ModelAlias,
  SUBSCRIPTION_CONNECTION,
  VERTEX_REGION_PREFIX,
} from "./connection.ts";

class ConnectionSettingsUnreadable extends TaggedError(
  "ConnectionSettingsUnreadable",
)<{
  path: string;
  cause: unknown;
  message: string;
}> {}

class ConnectionSettingsInvalid extends TaggedError(
  "ConnectionSettingsInvalid",
)<{
  path: string;
  message: string;
}> {}

type RepositoryOf = (worktree: string) => Promise<string | null>;

// Read for every turn so an edit applies from the next message; an unreadable file stops the turn rather than falling back to the subscription.
// A worktree the app created outside the repository still takes the repository's setting.
export const createConnectionResolver = ({
  path,
  repositoryOf = gitRepositoryOf,
}: {
  path: string;
  repositoryOf?: RepositoryOf;
}) => {
  const repositories = new Map<string, string>();

  const repositoryFor = async (worktree: string) => {
    const known = repositories.get(worktree);
    if (known !== undefined) return known;
    const found = await repositoryOf(worktree);
    if (found !== null) repositories.set(worktree, found);
    return found;
  };

  return (worktree: string) =>
    Result.gen(async function* () {
      const settings = yield* Result.await(readConnectionSettings(path));
      if (settings.size === 0) return Result.ok(SUBSCRIPTION_CONNECTION);
      const repository = await repositoryFor(worktree);
      return Result.ok(
        matchConnection(settings, [
          worktree,
          ...(repository === null ? [] : [repository]),
        ]),
      );
    });
};

export const readConnectionSettings = async (
  path: string,
): Promise<
  Result<
    Map<string, Connection>,
    ConnectionSettingsUnreadable | ConnectionSettingsInvalid
  >
> => {
  const read = await readTextFileIfExists(path);
  if (read.isErr()) {
    return Result.err(
      new ConnectionSettingsUnreadable({
        path,
        cause: read.error,
        message: `harnexus cannot read its connection settings in ${path}`,
      }),
    );
  }
  if (read.value === null) return Result.ok(new Map<string, Connection>());
  const parsed = parseJson(read.value);
  if (parsed.isErr()) return Result.err(invalid(path, "not valid JSON"));
  return parseSettings(parsed.value).mapError((problem) =>
    invalid(path, problem),
  );
};

// A folder inside a repository can keep a setting of its own.
const matchConnection = (
  settings: ReadonlyMap<string, Connection>,
  paths: readonly string[],
) => {
  let matched: { path: string; connection: Connection } | null = null;
  for (const [path, connection] of settings) {
    const inside = paths.some(
      (candidate) =>
        candidate === path || candidate.startsWith(`${path}${sep}`),
    );
    if (inside && (matched === null || path.length > matched.path.length)) {
      matched = { path, connection };
    }
  }
  return matched?.connection ?? SUBSCRIPTION_CONNECTION;
};

const gitRepositoryOf: RepositoryOf = async (worktree) => {
  const read = await readCommandOutput("git", [
    "-C",
    worktree,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (read.isErr()) return null;
  const common = read.value.trim();
  return basename(common) === ".git" ? dirname(common) : null;
};

const parseSettings = (
  value: unknown,
): Result<Map<string, Connection>, string> => {
  if (!isObject(value)) return Result.err("must be a JSON object");
  const unknown = unknownKey(value, ["repositories"], "");
  if (unknown !== null) return Result.err(unknown);
  const repositories = value.repositories ?? {};
  if (!isObject(repositories)) {
    return Result.err("repositories must be an object");
  }
  const settings = new Map<string, Connection>();
  for (const [path, entry] of Object.entries(repositories)) {
    if (!isAbsolute(path)) {
      return Result.err(`repository ${path} must be an absolute path`);
    }
    const connection = parseConnection(entry, `repository ${path}`);
    if (connection.isErr()) return Result.err(connection.error);
    settings.set(resolve(path), connection.value);
  }
  return Result.ok(settings);
};

const parseConnection = (
  entry: unknown,
  at: string,
): Result<Connection, string> => {
  if (!isObject(entry)) return Result.err(`${at} must be an object`);
  if (entry.provider === "subscription") {
    const unknown = unknownKey(entry, ["provider"], at);
    return unknown === null
      ? Result.ok(SUBSCRIPTION_CONNECTION)
      : Result.err(unknown);
  }
  if (entry.provider !== "vertex") {
    return Result.err(`${at} must set provider to "vertex" or "subscription"`);
  }
  const unknown = unknownKey(entry, VERTEX_KEYS, at);
  if (unknown !== null) return Result.err(unknown);
  if (!isText(entry.projectId, PROJECT_ID)) {
    return Result.err(`${at} must set projectId to a Google Cloud project ID`);
  }
  if (!isText(entry.region, REGION)) {
    return Result.err(`${at} must set region, such as global or us-east5`);
  }
  const credentialsFile = entry.credentialsFile ?? null;
  if (
    credentialsFile !== null &&
    !(typeof credentialsFile === "string" && isAbsolute(credentialsFile))
  ) {
    return Result.err(`${at} credentialsFile must be an absolute path`);
  }
  const models = entry.models ?? {};
  if (!isModels(models)) {
    return Result.err(
      `${at} models must map opus, sonnet or haiku to a model ID`,
    );
  }
  const modelRegions = entry.modelRegions ?? {};
  if (!isModelRegions(modelRegions)) {
    return Result.err(
      `${at} modelRegions must map ${VERTEX_REGION_PREFIX}* variables to regions`,
    );
  }
  return Result.ok({
    provider: "vertex",
    projectId: entry.projectId,
    region: entry.region,
    credentialsFile,
    models,
    modelRegions,
  });
};

// An unknown key is refused, since a misspelt one would otherwise be ignored without notice.
const unknownKey = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
) => {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  return unknown === undefined
    ? null
    : `${at === "" ? "" : `${at} `}has an unknown key ${unknown}`;
};

const isModels = (
  value: unknown,
): value is Partial<Record<ModelAlias, string>> =>
  isObject(value) &&
  Object.entries(value).every(
    ([alias, model]) =>
      (MODEL_ALIASES as readonly string[]).includes(alias) &&
      isText(model, MODEL_ID),
  );

const isModelRegions = (value: unknown): value is Record<string, string> =>
  isObject(value) &&
  Object.entries(value).every(
    ([name, region]) => REGION_VARIABLE.test(name) && isText(region, REGION),
  );

const invalid = (path: string, problem: string) =>
  new ConnectionSettingsInvalid({
    path,
    message: `harnexus connection settings in ${path}: ${problem}`,
  });

const isText = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

const VERTEX_KEYS = [
  "provider",
  "projectId",
  "region",
  "credentialsFile",
  "models",
  "modelRegions",
];

const MODEL_ALIASES: readonly ModelAlias[] = ["opus", "sonnet", "haiku"];

// Domain-scoped projects such as example.com:project contain a dot and a colon.
const PROJECT_ID = /^[a-z0-9][a-z0-9.:-]*$/;

const REGION = /^[a-z0-9-]+$/;

const MODEL_ID = /^\S+$/;

const REGION_VARIABLE = new RegExp(`^${VERTEX_REGION_PREFIX}[A-Z0-9_]+$`);
