// Versions of the Codex CLI the app bundles on which the bridge's rewrites were checked in the app; a new app release can change the protocol under them.
const VERIFIED_CODEX_VERSIONS: readonly string[] = ["0.158.0-alpha.2.1"];

// The server's initialize answer names its version after the client name, as in "Codex Desktop/0.158.0-alpha.2.1 (Mac OS 26.5.1; arm64)", so only a version-shaped part after a slash is taken and a slash in the name is skipped.
export const codexVersion = (userAgent: unknown) => {
  if (typeof userAgent !== "string") return null;
  return /\/(\d+\.\d+\.\d+[^\s/]*)/.exec(userAgent)?.[1] ?? null;
};

export const isVerifiedCodex = (version: string | null) =>
  version !== null && VERIFIED_CODEX_VERSIONS.includes(version);
