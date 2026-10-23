// A review bot is described by data alone, so moving to another AI reviewer changes the config, not the watch.
export type ReviewBot = {
  // The key the watch records the bot's reviews under; keep it when other fields change.
  id: string;
  // Shown to the worker.
  name: string;
  login: string;
  // The commit status the bot keeps while it reviews a head.
  // Without one, its findings are sent as they come and no completion is told.
  status: { context: string; completed: string } | null;
  // A review body without this text carries no findings of its own; null takes every review body.
  actionableReview: string | null;
  // A PR comment with this text says the bot found nothing, which the watch checks against the findings it saw.
  noActionable: string | null;
  // Read from an inline finding; the first group is the severity shown to the worker.
  severity: string | null;
};

export const PRESETS = {
  coderabbit: {
    id: "coderabbit",
    name: "CodeRabbit",
    login: "coderabbitai[bot]",
    status: { context: "CodeRabbit", completed: "Review completed" },
    actionableReview: "Actionable comments posted",
    noActionable: "No actionable comments were generated",
    // CodeRabbit opens a finding with a bold category and severity, such as **🟠 Major**.
    severity: String.raw`\*\*[^*\n]*?\b(Critical|Major|Minor|Trivial|Info)\*\*`,
  },
} as const satisfies Record<string, ReviewBot>;

export type PresetName = keyof typeof PRESETS;

export const botOf = (bots: readonly ReviewBot[], login: string) =>
  bots.find((bot) => bot.login.toLowerCase() === login.toLowerCase()) ?? null;

export const severityOf = (bot: ReviewBot, body: string) =>
  bot.severity === null ? undefined : compiled(bot.severity).exec(body)?.[1];

// Each pattern is compiled once, since every inline comment of every read is matched against it.
const compiled = (source: string) => {
  const kept = PATTERNS.get(source);
  if (kept !== undefined) return kept;

  const pattern = new RegExp(source);
  PATTERNS.set(source, pattern);
  return pattern;
};

const PATTERNS = new Map<string, RegExp>();
