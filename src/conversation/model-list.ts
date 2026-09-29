import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_MODELS,
  DEFAULT_EFFORT,
  supportsEffort,
} from "../infra/claude/models.ts";

// Claude models join the last page only, so a paging client sees each once; an id the server already lists is reported, since requests for it still go to Claude.
export const withClaudeModels = (result: Record<string, unknown>) => {
  const data = result.data;
  if (!Array.isArray(data) || (result.nextCursor ?? null) !== null) {
    return { result, collisions: [] };
  }
  const listed = new Set(data.map((model) => modelId(model)));
  const collisions = CLAUDE_MODELS.filter(({ id }) => listed.has(id)).map(
    ({ id }) => id,
  );
  const added = CLAUDE_MODELS.filter(({ id }) => !listed.has(id)).map(
    modelEntry,
  );
  return { result: { ...result, data: [...data, ...added] }, collisions };
};

// The app shows a thread's effort from what the server reports, so a level the model cannot run, or none, is shown as the one the picker offers first.
export const shownEffort = (model: string, effort: EffortLevel | null) =>
  effort !== null && supportsEffort(model, effort) ? effort : DEFAULT_EFFORT;

const modelEntry = ({
  id,
  displayName,
  efforts,
}: (typeof CLAUDE_MODELS)[number]) => ({
  id,
  model: id,
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName,
  description: `${displayName} through Claude Code`,
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: reasoningEfforts(displayName, efforts),
  defaultReasoningEffort: DEFAULT_EFFORT,
  inputModalities: ["text"],
  supportsPersonality: false,
  multiAgentVersion: null,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  availableAccessPrograms: null,
  isDefault: false,
});

// The app offers only listed levels, so a model without effort still lists one to keep the picker usable.
const reasoningEfforts = (
  displayName: string,
  efforts: readonly EffortLevel[],
) =>
  efforts.length === 0
    ? [
        {
          reasoningEffort: DEFAULT_EFFORT,
          description: `${displayName} does not use effort levels`,
        },
      ]
    : efforts.map((effort) => ({
        reasoningEffort: effort,
        description: EFFORT_DESCRIPTIONS[effort],
      }));

const modelId = (model: unknown) =>
  typeof model === "object" && model !== null && "id" in model
    ? model.id
    : undefined;

// Worded after the SDK's EffortLevel documentation.
const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low: "Minimal thinking, fastest responses",
  medium: "Moderate thinking",
  high: "Deep reasoning",
  xhigh: "Deeper than high",
  max: "Maximum effort",
};
