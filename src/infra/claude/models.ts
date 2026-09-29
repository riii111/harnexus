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

// The level a thread with none picked runs at, or null for a model without effort.
export type EffortDefaults = (model: string) => EffortLevel | null;

export const isClaudeModel = (model: unknown): model is string =>
  CLAUDE_MODELS.some(({ id }) => id === model);

// A level of some Claude model, which a thread keeps even while its current model cannot run it.
export const isClaudeEffort = (effort: unknown): effort is EffortLevel =>
  CLAUDE_MODELS.some(({ efforts }) =>
    (efforts as readonly unknown[]).includes(effort),
  );

const effortsOf = (model: string): readonly EffortLevel[] =>
  CLAUDE_MODELS.find(({ id }) => id === model)?.efforts ?? [];

// A level from the user's settings is the one Claude Code itself would start from, and the SDK documents high as the model default.
export const effortDefaults =
  (settings: Pick<Settings, "effortLevel" | "modelSettings">): EffortDefaults =>
  (model) => {
    if (effortsOf(model).length === 0) return null;
    const configured =
      settings.modelSettings?.[model]?.effortLevel ?? settings.effortLevel;
    return configured !== undefined && supportsEffort(model, configured)
      ? configured
      : MODEL_DEFAULT_EFFORT;
  };

// A picked level the model cannot run falls back to the default, so a thread always runs at a level it can show.
export const runEffort = (
  model: string,
  picked: EffortLevel | null,
  defaults: EffortDefaults,
) =>
  picked !== null && supportsEffort(model, picked) ? picked : defaults(model);

const supportsEffort = (model: string, effort: EffortLevel) =>
  effortsOf(model).includes(effort);

const MODEL_DEFAULT_EFFORT: EffortLevel = "high";
