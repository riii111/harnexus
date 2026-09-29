import type { EffortLevel, Settings } from "@anthropic-ai/claude-agent-sdk";

// Ids are SDK model names, whose "claude-" prefix keeps them apart from Codex model ids.
// efforts are the levels the SDK's supportedModels() reports for the model (SDK 0.3.282), and a model without any does not take effort.
export const CLAUDE_MODELS = [
  {
    id: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", efforts: [] },
] as const satisfies readonly {
  id: string;
  displayName: string;
  efforts: readonly EffortLevel[];
}[];

// The level a thread runs at on the model given the level picked for it, or null for a model without effort.
export type EffortRule = (
  model: string,
  picked: EffortLevel | null,
) => EffortLevel | null;

export type EffortSettings = Pick<
  Settings,
  "effortLevel" | "maxEffortLevel" | "modelSettings"
>;

export const isClaudeModel = (model: unknown): model is string =>
  CLAUDE_MODELS.some(({ id }) => id === model);

// A level of some Claude model, which a thread keeps even while its current model cannot run it.
export const isClaudeEffort = (effort: unknown): effort is EffortLevel =>
  CLAUDE_MODELS.some(({ efforts }) =>
    (efforts as readonly unknown[]).includes(effort),
  );

const effortsOf = (model: string): readonly EffortLevel[] =>
  CLAUDE_MODELS.find(({ id }) => id === model)?.efforts ?? [];

// Without a pick a thread starts where Claude Code would, from the settings or else the model default the SDK documents as high, and the settings' cap lowers any level as Claude Code does.
export const effortRule =
  (settings: EffortSettings): EffortRule =>
  (model, picked) => {
    if (effortsOf(model).length === 0) return null;
    const perModel = settings.modelSettings?.[model];
    const configured = perModel?.effortLevel ?? settings.effortLevel;
    const wanted =
      picked !== null && supportsEffort(model, picked)
        ? picked
        : configured !== undefined && supportsEffort(model, configured)
          ? configured
          : MODEL_DEFAULT_EFFORT;
    const cap = perModel?.maxEffortLevel ?? settings.maxEffortLevel;
    return cap !== undefined && rank(wanted) > rank(cap) ? cap : wanted;
  };

const supportsEffort = (model: string, effort: EffortLevel) =>
  effortsOf(model).includes(effort);

const rank = (effort: EffortLevel) => EFFORT_ORDER.indexOf(effort);

const EFFORT_ORDER: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const MODEL_DEFAULT_EFFORT: EffortLevel = "high";
