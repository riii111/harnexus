import {
  type CompatibilityEvent,
  compatibilityVersion,
  responseCompatibility,
} from "../infra/codex/compatibility.ts";
import { codexVersion, isVerifiedCodex } from "../infra/codex/versions.ts";

export type CompatibilityLogEvent =
  | CompatibilityEvent
  | { event: "codex_version"; version: string | null; verified: boolean };

export const createCompatibility = (
  log: (event: CompatibilityLogEvent) => void,
) => {
  // While the server is incompatible, a Claude turn is refused rather than handed to Codex, which would run it without the Claude conversation.
  let incompatible = false;
  let serverVersion: string | null = null;

  return {
    isIncompatible: () => incompatible,
    // Marks the server incompatible when a response shows a protocol the bridge was not verified against.
    judge: (
      kind: "initialize" | "modelList",
      message: Record<string, unknown>,
    ) => {
      const reason = responseCompatibility(kind, message);
      if (reason === null) return false;
      if (!incompatible) {
        incompatible = true;
        log({ event: "codex_incompatible", reason, version: serverVersion });
      }
      return true;
    },
    noteInitialized: (result: Record<string, unknown>) => {
      const version = codexVersion(result.userAgent);
      const verified = isVerifiedCodex(version);
      serverVersion = compatibilityVersion(version);
      log({ event: "codex_version", version, verified });
    },
  };
};
