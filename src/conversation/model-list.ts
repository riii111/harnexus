import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import {
  type ClaudeModel,
  type EffortRule,
  isClaudeModel,
  type ModelCatalog,
  vertexModelId,
} from "../infra/claude/models.ts";

// vertex lists the Vertex AI twins in the picker; without it they stay hidden, so a thread already on one is still named.
export type ListedClaudeModels = ReturnType<ModelCatalog["models"]> & {
  vertex?: boolean;
};

// Claude models join the last page only, so a paging client sees each once; a server id with the Claude prefix is reported, since requests for it go to Claude.
// A retired model is listed hidden, so the app can still name the model of a thread already on it.
export const withClaudeModels = (
  result: Record<string, unknown>,
  { offered, retired, vertex = false }: ListedClaudeModels,
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
  const collisions = data
    .map((model) => modelId(model))
    .filter((id) => isClaudeModel(id));
  const added = [
    ...models,
    ...models.map(({ model, hidden }) => ({
      model: vertexTwin(model),
      hidden: hidden || !vertex,
    })),
  ]
    .filter(({ model }) => !listed.has(model.id))
    .map(({ model, hidden }) =>
      modelEntry(model, hidden, rule(model.id, null)),
    );
  return { result: { ...result, data: [...data, ...added] }, collisions };
};

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
  // The app lets the user attach images only to a model that lists them; every Claude model reads images.
  inputModalities: ["text", "image"],
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

const vertexTwin = (model: ClaudeModel): ClaudeModel => ({
  ...model,
  id: vertexModelId(model.id),
  displayName: `${model.displayName} · Vertex AI`,
  description: `${model.description} on Google Vertex AI`,
});

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
