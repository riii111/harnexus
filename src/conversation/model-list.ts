import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeModel,
  EffortRule,
  ModelCatalog,
} from "../infra/claude/models.ts";

// Claude models join the last page only, so a paging client sees each once; an id the server already lists is reported, since requests for it still go to Claude.
// A retired model is listed hidden, so the app can still name the model of a thread already on it.
export const withClaudeModels = (
  result: Record<string, unknown>,
  { offered, retired }: ReturnType<ModelCatalog["models"]>,
  rule: EffortRule,
) => {
  const data = result.data;
  if (!Array.isArray(data) || (result.nextCursor ?? null) !== null) {
    return { result, collisions: [] };
  }
  const listed = new Set(data.map((model) => modelId(model)));
  const models = [
    ...offered.map((model) => ({ model, hidden: false })),
    ...retired.map((model) => ({ model, hidden: true })),
  ];
  const collisions = models
    .filter(({ model }) => listed.has(model.id))
    .map(({ model }) => model.id);
  const added = models
    .filter(({ model }) => !listed.has(model.id))
    .map(({ model, hidden }) =>
      modelEntry(model, hidden, rule(model.id, null)),
    );
  return { result: { ...result, data: [...data, ...added] }, collisions };
};

// A model without effort still reports a level, which is the single entry its picker lists.
export const shownEffort = (effort: EffortLevel | null) =>
  effort ?? NO_EFFORT_ENTRY;

const modelEntry = (
  { id, displayName, description, efforts }: ClaudeModel,
  hidden: boolean,
  defaultEffort: EffortLevel | null,
) => ({
  id,
  model: id,
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName,
  description,
  modelSpecialty: null,
  hidden,
  supportedReasoningEfforts: reasoningEfforts(displayName, efforts),
  defaultReasoningEffort: shownEffort(defaultEffort),
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
          reasoningEffort: NO_EFFORT_ENTRY,
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

const NO_EFFORT_ENTRY: EffortLevel = "medium";

// Worded after the SDK's EffortLevel documentation.
const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low: "Minimal thinking, fastest responses",
  medium: "Moderate thinking",
  high: "Deep reasoning",
  xhigh: "Deeper than high",
  max: "Maximum effort",
};
