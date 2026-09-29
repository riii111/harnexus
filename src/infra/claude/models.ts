import type {
  EffortLevel,
  ModelInfo,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";

// efforts are the levels the model takes, and a model without any does not take effort.
export type ClaudeModel = {
  id: string;
  displayName: string;
  description: string;
  efforts: readonly EffortLevel[];
};

export type ModelCatalog = ReturnType<typeof createModelCatalog>;

// The level a thread runs at on the model given the level picked for it, or null for a model without effort.
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

// A level of some Claude model, which a thread keeps even while its current model cannot run it.
export const isClaudeEffort = (effort: unknown): effort is EffortLevel =>
  (EFFORT_ORDER as readonly unknown[]).includes(effort);

// The models Claude Code lists replace the built-in ones once read; a built-in model it no longer lists stays for the threads already on it.
export const createModelCatalog = () => {
  let listed: readonly ClaudeModel[] | null = null;
  let settle = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    replace: (models: readonly ClaudeModel[]) => {
      listed = models;
      settle();
    },
    // The built-in models stay, and a turn waiting for the list goes on with them.
    giveUp: () => settle(),
    settled: () => settled,
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
    effortsOf: (model: string): readonly EffortLevel[] =>
      (
        listed?.find(({ id }) => id === model) ??
        BUILT_IN_MODELS.find(({ id }) => id === model)
      )?.efforts ?? [],
  };
};

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

// Without a pick a thread starts where Claude Code would, from the settings or else the model default the SDK documents as high, and the settings' cap lowers any level as Claude Code does.
export const effortRule =
  (
    settings: EffortSettings,
    effortsOf: (model: string) => readonly EffortLevel[],
  ): EffortRule =>
  (model, picked) => {
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
    return cap !== undefined && rank(wanted) > rank(cap) ? cap : wanted;
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

const CLAUDE_PREFIX = "claude-";

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
