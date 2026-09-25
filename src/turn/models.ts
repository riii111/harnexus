// Ids are SDK model names, whose "claude-" prefix keeps them apart from Codex model ids.
const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
] as const;

export const isClaudeModel = (model: unknown): model is string =>
  CLAUDE_MODELS.some(({ id }) => id === model);

// The app's collaboration mode takes precedence over the plain model field, so both are read in that order.
export const requestedModel = (params: Record<string, unknown>) => {
  const settings = collaborationMode(params)?.settings;
  if (isObject(settings) && typeof settings.model === "string") {
    return settings.model;
  }
  return typeof params.model === "string" ? params.model : undefined;
};

// Plan mode would need Claude's plan approval, which is relayed only from P9.
export const requestsUnsupportedMode = (params: Record<string, unknown>) => {
  const mode = collaborationMode(params)?.mode;
  return mode !== undefined && mode !== "default";
};

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
    ({ id, displayName }) => modelEntry(id, displayName),
  );
  return { result: { ...result, data: [...data, ...added] }, collisions };
};

// Reasoning effort is not passed to Claude yet, so a single level is offered.
const modelEntry = (id: string, displayName: string) => ({
  id,
  model: id,
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName,
  description: `${displayName} through Claude Code`,
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Claude Code default" },
  ],
  defaultReasoningEffort: "medium",
  inputModalities: ["text"],
  supportsPersonality: false,
  multiAgentVersion: null,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  availableAccessPrograms: null,
  isDefault: false,
});

const collaborationMode = (params: Record<string, unknown>) =>
  isObject(params.collaborationMode) ? params.collaborationMode : undefined;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const modelId = (model: unknown) =>
  typeof model === "object" && model !== null && "id" in model
    ? model.id
    : undefined;
