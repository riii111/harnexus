// Ids are SDK model names, whose "claude-" prefix keeps them apart from Codex model ids.
export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
] as const;

export const isClaudeModel = (model: unknown): model is string =>
  CLAUDE_MODELS.some(({ id }) => id === model);
