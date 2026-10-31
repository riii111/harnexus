import { fileURLToPath } from "node:url";
import { Result } from "better-result";

// The SDK ships a claude binary per platform, which the bridge already runs signed in; it is found the way the package manager installed it.
export const bundledClaude = (
  resolve: (specifier: string) => string = (specifier) =>
    import.meta.resolve(specifier),
): string | null => {
  const found = Result.try(() =>
    resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    ),
  );
  if (found.isErr()) return null;
  return fileURLToPath(new URL("claude", found.value));
};
