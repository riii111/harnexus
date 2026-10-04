import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import {
  type ClaudeModel,
  type EffortRule,
  isClaudeModel,
  type ModelCatalog,
} from "../infra/claude/models.ts";
import { isObject } from "../runtime/object.ts";

// Claude models join the last page only, so a paging client sees each once; a server id with the Claude prefix is reported, since requests for it go to Claude.
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
  const collisions = data
    .map((model) => modelId(model))
    .filter((id) => isClaudeModel(id));
  const added = [
    ...models,
    ...models.map(({ model }) => ({ model: vertexTwin(model), hidden: true })),
  ]
    .filter(({ model }) => !listed.has(model.id))
    .map(({ model, hidden }) =>
      modelEntry(model, hidden, rule(baseModelId(model.id), null)),
    );
  return { result: { ...result, data: [...data, ...added] }, collisions };
};

// The app's model list names no repository, so a thread on Vertex AI is shown under a hidden twin of its model whose name carries the provider.
export const shownModelId = (model: string, provider: string | undefined) =>
  provider === "vertex" ? `${model}${VERTEX_SUFFIX}` : model;

export const baseModelId = <T>(model: T): T =>
  typeof model === "string" && model.endsWith(VERTEX_SUFFIX)
    ? (model.slice(0, -VERTEX_SUFFIX.length) as T)
    : model;

// The app sends a thread's shown model back, which Claude would not know.
export const withBaseModels = (
  params: Record<string, unknown>,
): Record<string, unknown> => {
  const mode = params.collaborationMode;
  const settings = isObject(mode) ? mode.settings : undefined;
  return {
    ...params,
    ...("model" in params && { model: baseModelId(params.model) }),
    ...(isObject(mode) &&
      isObject(settings) &&
      "model" in settings && {
        collaborationMode: {
          ...mode,
          settings: { ...settings, model: baseModelId(settings.model) },
        },
      }),
  };
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

const vertexTwin = (model: ClaudeModel): ClaudeModel => ({
  ...model,
  id: shownModelId(model.id, "vertex"),
  displayName: `${model.displayName} · Vertex AI`,
  description: `${model.description} on Google Vertex AI`,
});

const modelId = (model: unknown) =>
  typeof model === "object" && model !== null && "id" in model
    ? model.id
    : undefined;

const NO_EFFORT_ENTRY: EffortLevel = "medium";

const VERTEX_SUFFIX = "~vertex";

// Worded after the SDK's EffortLevel documentation.
const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low: "Minimal thinking, fastest responses",
  medium: "Moderate thinking",
  high: "Deep reasoning",
  xhigh: "Deeper than high",
  max: "Maximum effort",
};
