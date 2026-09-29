import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

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

// Shown for a thread with no level picked, which runs at the effortLevel of the user's settings (medium on the verification Mac) or else the model's default.
export const DEFAULT_EFFORT: EffortLevel = "medium";

export const isClaudeModel = (model: unknown): model is string =>
  CLAUDE_MODELS.some(({ id }) => id === model);

// A level of some Claude model, which a thread keeps even while its current model cannot run it.
export const isClaudeEffort = (effort: unknown): effort is EffortLevel =>
  CLAUDE_MODELS.some(({ efforts }) =>
    (efforts as readonly unknown[]).includes(effort),
  );

const effortsOf = (model: string): readonly EffortLevel[] =>
  CLAUDE_MODELS.find(({ id }) => id === model)?.efforts ?? [];

export const supportsEffort = (model: string, effort: EffortLevel) =>
  effortsOf(model).includes(effort);
