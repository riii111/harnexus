import { basename, dirname, join } from "node:path";
import {
  resolveSettings,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { type InferErr, Result, TaggedError } from "better-result";
import { readTextFileIfExists } from "../../runtime/fs.boundary.ts";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import { readCommandOutput } from "../../runtime/process.boundary.ts";
import {
  type Connection,
  SUBSCRIPTION_CONNECTION,
  VERTEX_REGION_PREFIX,
} from "./connection.ts";
import { type ClaudeSdk, readSettingsLayer } from "./sdk.boundary.ts";

class RepositorySettingsUnreadable extends TaggedError(
  "RepositorySettingsUnreadable",
)<{
  path: string;
  message: string;
}> {}

class VertexSettingsIncomplete extends TaggedError("VertexSettingsIncomplete")<{
  name: string;
  message: string;
}> {}

class VertexGatewayUnsupported extends TaggedError("VertexGatewayUnsupported")<{
  name: string;
  message: string;
}> {}

type RepositoryOf = (worktree: string) => Promise<string | null>;

// Only a repository's own Claude Code settings choose Vertex, so a Vertex login in the user's settings never moves every repository; a setting that cannot be read stops the turn rather than falling back to the subscription.
// Claude Code reads settings from the directory it runs in, and a worktree the app created has no copy of the untracked settings.local.json, so the repository's settings sit under the worktree's own in the same order Claude Code ranks shared and local settings.
export const createConnectionResolver = ({
  resolve = resolveSettings,
  repositoryOf = gitRepositoryOf,
}: {
  resolve?: ClaudeSdk["resolveSettings"];
  repositoryOf?: RepositoryOf;
} = {}) => {
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
      const repository = await repositoryFor(worktree);
      const env: Record<string, string> = {};
      for (const [dir, source] of layersOf(worktree, repository)) {
        const layer = yield* Result.await(readLayer(resolve, dir, source));
        Object.assign(env, layer);
      }
      return choosesVertex(env)
        ? vertexFrom(env)
        : Result.ok<Connection>(SUBSCRIPTION_CONNECTION);
    });
};

const layersOf = (
  worktree: string,
  repository: string | null,
): [string, SettingSource][] =>
  repository === null || repository === worktree
    ? [
        [worktree, "project"],
        [worktree, "local"],
      ]
    : [
        [repository, "project"],
        [worktree, "project"],
        [repository, "local"],
        [worktree, "local"],
      ];

// The SDK reads a settings file it cannot parse or refuses as having no settings, which would leave a Vertex repository on the subscription.
const readLayer = async (
  resolve: ClaudeSdk["resolveSettings"],
  dir: string,
  source: SettingSource,
): Promise<
  Result<
    Record<string, string>,
    | RepositorySettingsUnreadable
    | InferErr<Awaited<ReturnType<typeof readSettingsLayer>>>
  >
> => {
  const path = join(dir, ".claude", SETTINGS_FILES[source]);
  const text = await readTextFileIfExists(path);
  if (text.isErr()) return Result.err(unreadable(path));
  const layer = await readSettingsLayer(resolve, dir, source);
  if (layer.isErr()) return Result.err(layer.error);
  if (text.value !== null && !acceptedAs(text.value, layer.value.loaded)) {
    return Result.err(unreadable(path));
  }
  return Result.ok(layer.value.env);
};

const unreadable = (path: string) =>
  new RepositorySettingsUnreadable({
    path,
    message: `harnexus cannot read the Claude Code settings in ${path}, so nothing was sent to Claude`,
  });

const vertexFrom = (
  env: Record<string, string>,
): Result<Connection, VertexSettingsIncomplete | VertexGatewayUnsupported> => {
  const gateway = GATEWAY_ENV.find((name) => env[name] !== undefined);
  if (gateway !== undefined) {
    return Result.err(
      new VertexGatewayUnsupported({
        name: gateway,
        message: `this repository's Claude Code settings set ${gateway}, which harnexus does not support, so nothing was sent to Claude`,
      }),
    );
  }
  const projectId = env.ANTHROPIC_VERTEX_PROJECT_ID ?? "";
  const region = env.CLOUD_ML_REGION ?? "";
  const missing =
    projectId === ""
      ? "ANTHROPIC_VERTEX_PROJECT_ID"
      : region === ""
        ? "CLOUD_ML_REGION"
        : null;
  if (missing !== null) {
    return Result.err(
      new VertexSettingsIncomplete({
        name: missing,
        message: `this repository's Claude Code settings choose Google Vertex AI without ${missing}, so nothing was sent to Claude`,
      }),
    );
  }
  return Result.ok({
    provider: "vertex",
    projectId,
    region,
    env: Object.fromEntries(
      Object.entries(env).filter(([name]) => isPassedToClaude(name)),
    ),
  });
};

// The SDK lists no source for an empty settings file either, which holds nothing it could have dropped.
const acceptedAs = (text: string, loaded: boolean) => {
  const parsed = parseJson(text);
  return (
    parsed.isOk() &&
    isObject(parsed.value) &&
    (loaded || Object.keys(parsed.value).length === 0)
  );
};

const choosesVertex = (env: Record<string, string>) =>
  TRUTHY.has((env.CLAUDE_CODE_USE_VERTEX ?? "").toLowerCase());

// Other variables in the settings, such as another tool's API key, stay where Claude Code itself would read them.
const isPassedToClaude = (name: string) =>
  VERTEX_PASSED_ENV.has(name) ||
  name.startsWith(VERTEX_REGION_PREFIX) ||
  MODEL_PIN.test(name);

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

const SETTINGS_FILES: Record<SettingSource, string> = {
  user: "settings.json",
  project: "settings.json",
  local: "settings.local.json",
};

const TRUTHY = new Set(["1", "true", "yes", "on"]);

const VERTEX_PASSED_ENV = new Set([
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

const MODEL_PIN = /^ANTHROPIC_DEFAULT_[A-Z]+_MODEL$/;

const GATEWAY_ENV = [
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
];
