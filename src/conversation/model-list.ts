import { CLAUDE_MODELS } from "../infra/claude/models.ts";

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

const modelId = (model: unknown) =>
  typeof model === "object" && model !== null && "id" in model
    ? model.id
    : undefined;
