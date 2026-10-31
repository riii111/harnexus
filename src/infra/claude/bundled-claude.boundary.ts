import { fileURLToPath } from "node:url";
import { Result } from "better-result";

// The claude binary the SDK ships for this platform, which the bridge already runs signed in.
export const bundledClaude = (
  resolve: (specifier: string) => string = (specifier) =>
    import.meta.resolve(specifier),
): string | null => {
  // Found the way the package manager installed it.
  const found = Result.try(() =>
    resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    ),
  );
  if (found.isErr()) return null;
  return fileURLToPath(new URL("claude", found.value));
};
