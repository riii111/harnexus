import type {
  EffortLevel,
  ModelInfo,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";

export type ClaudeModel = {
  id: string;
  displayName: string;
  description: string;
  efforts: readonly EffortLevel[];
};

export type ModelCatalog = ReturnType<typeof createModelCatalog>;

export type EffortRule = (
  model: string,
  picked: EffortLevel | null,
) => EffortLevel | null;

export type EffortSettings = Pick<
  Settings,
  "effortLevel" | "maxEffortLevel" | "modelSettings"
>;

// Ids are SDK model names, whose "claude-" prefix keeps them apart from Codex model ids, so a thread on a model Claude Code no longer lists is still a Claude thread.
export const isClaudeModel = (model: unknown): model is string =>
  typeof model === "string" && model.startsWith(CLAUDE_PREFIX);

// A model picked with this suffix runs the same Claude model on Google Vertex AI, so the picker shows the connection before a chat starts.
export const vertexModelId = (model: string) => `${model}${VERTEX_SUFFIX}`;

export const isVertexModel = (model: string) => model.endsWith(VERTEX_SUFFIX);

export const baseModelId = (model: string) =>
  isVertexModel(model) ? model.slice(0, -VERTEX_SUFFIX.length) : model;

// A level of some Claude model, which a thread keeps even while its current model cannot run it.
export const isClaudeEffort = (effort: unknown): effort is EffortLevel =>
  (EFFORT_ORDER as readonly unknown[]).includes(effort);

// The models Claude Code lists replace the built-in ones once read; a built-in model it no longer lists stays for the threads already on it.
export const createModelCatalog = () => {
  let listed: readonly ClaudeModel[] | null = null;
  return {
    replace: (models: readonly ClaudeModel[]) => {
      listed = newestFirst(models);
    },
    models: (): {
      offered: readonly ClaudeModel[];
      retired: readonly ClaudeModel[];
    } =>
      listed === null
        ? { offered: BUILT_IN_MODELS, retired: [] }
        : {
            offered: listed,
            retired: BUILT_IN_MODELS.filter(
              ({ id }) => !listed?.some((model) => model.id === id),
            ),
          },
    // A model neither list names, such as one only Claude Code's unread list has, is given every level, so a saved pick is not lost; the SDK ran xhigh as high on Opus 4.6 and ignored a level on Haiku 4.5 (SDK 0.3.284).
    effortsOf: (picked: string): readonly EffortLevel[] => {
      const model = baseModelId(picked);
      return (
        (
          listed?.find(({ id }) => id === model) ??
          BUILT_IN_MODELS.find(({ id }) => id === model)
        )?.efforts ?? EFFORT_ORDER
      );
    },
  };
};

// The SDK gives no release date, so the version in the name stands in for it across families; a tie keeps the given order and a name without a version goes last.
const newestFirst = (models: readonly ClaudeModel[]): ClaudeModel[] =>
  models
    .map((model) => ({ model, version: versionOf(model.displayName) }))
    .sort((a, b) => compareVersions(b.version, a.version))
    .map(({ model }) => model);

// An alias such as sonnet is pinned to the model it resolves to now, while an explicit id keeps a suffix such as [1m] that picks the context window.
export const modelsFromSdk = (infos: readonly ModelInfo[]): ClaudeModel[] => {
  const models: ClaudeModel[] = [];
  for (const info of infos) {
    if (info.value === DEFAULT_ALIAS) continue;
    const id = isClaudeModel(info.value) ? info.value : info.resolvedModel;
    if (!isClaudeModel(id) || models.some((model) => model.id === id)) continue;
    models.push({
      id,
      displayName: `Claude ${versionedName(info)}`,
      description: info.description,
      efforts: info.supportedEffortLevels ?? [],
    });
  }
  return models;
};

// Without a pick a thread starts where Claude Code would, from the settings or else the model default the SDK documents as high, and the settings' cap lowers any level as Claude Code does, down to a level the model runs.
export const effortRule =
  (
    settings: EffortSettings,
    effortsOf: (model: string) => readonly EffortLevel[],
  ): EffortRule =>
  (pickedModel, picked) => {
    const model = baseModelId(pickedModel);
    const efforts = effortsOf(model);
    if (efforts.length === 0) return null;
    // modelSettings is keyed by the canonical name, which an id such as claude-fable-5-1[1m] extends with its context suffix.
    const perModel =
      settings.modelSettings?.[model] ??
      settings.modelSettings?.[model.replace(CONTEXT_SUFFIX, "")];
    const configured = perModel?.effortLevel ?? settings.effortLevel;
    const wanted =
      picked !== null && efforts.includes(picked)
        ? picked
        : configured !== undefined && efforts.includes(configured)
          ? configured
          : MODEL_DEFAULT_EFFORT;
    const cap = perModel?.maxEffortLevel ?? settings.maxEffortLevel;
    const limit =
      cap !== undefined && rank(wanted) > rank(cap) ? rank(cap) : rank(wanted);
    const ascending = [...efforts].sort((a, b) => rank(a) - rank(b));
    const runnable = ascending.filter((effort) => rank(effort) <= limit);
    return runnable[runnable.length - 1] ?? ascending[0] ?? null;
  };

// An alias's displayName is a family such as Opus, and its version comes before the description's separator; a description that does not start with the name, such as an upgrade hint, is not a name.
const versionedName = (info: ModelInfo) => {
  const [name] = info.description.split(DESCRIPTION_SEPARATOR);
  return info.description.includes(DESCRIPTION_SEPARATOR) &&
    name?.startsWith(info.displayName)
    ? name
    : info.displayName;
};

const rank = (effort: EffortLevel) => EFFORT_ORDER.indexOf(effort);

// A number standing alone in a name such as "Claude Opus 4.6 (1M)", so a context size such as 1M is not read as a version.
const versionOf = (displayName: string): readonly number[] | null => {
  const version = VERSION.exec(displayName)?.[1];
  return version === undefined ? null : version.split(".").map(Number);
};

const compareVersions = (
  a: readonly number[] | null,
  b: readonly number[] | null,
): number => {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const VERSION = /(?:^|\s)(\d+(?:\.\d+)*)(?=\s|$)/;

const CLAUDE_PREFIX = "claude-";

const VERTEX_SUFFIX = "~vertex";

const CONTEXT_SUFFIX = /\[[^\]]*\]$/;

// The row for the user's default model duplicates the row of the model it names.
const DEFAULT_ALIAS = "default";

const DESCRIPTION_SEPARATOR = " · ";

const EFFORT_ORDER: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const MODEL_DEFAULT_EFFORT: EffortLevel = "high";

// Offered until Claude Code's own list is read, and kept for threads already on a model it drops (SDK 0.3.282).
const BUILT_IN_MODELS: readonly ClaudeModel[] = [
  {
    id: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    description: "Claude Opus 5.5 through Claude Code",
    efforts: EFFORT_ORDER,
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    description: "Claude Sonnet 5 through Claude Code",
    efforts: EFFORT_ORDER,
  },
  {
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    description: "Claude Haiku 4.5 through Claude Code",
    efforts: [],
  },
];
