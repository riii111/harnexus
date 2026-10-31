import { isObject } from "../../runtime/object.ts";

type CompatibilityFailure =
  | "InitializeResponseChanged"
  | "ModelListResponseChanged";
export type CompatibilityEvent = {
  event: "codex_incompatible";
  reason: CompatibilityFailure;
  version: string | null;
};

export const responseCompatibility = (
  kind: "initialize" | "modelList",
  message: Record<string, unknown>,
): CompatibilityFailure | null => {
  // An RPC error can come from authentication or a transient server failure, so it is not evidence of a changed protocol.
  if ("error" in message) return null;
  const result = message.result;
  if (kind === "initialize") {
    return isObject(result) && typeof result.userAgent === "string"
      ? null
      : "InitializeResponseChanged";
  }
  if (
    !isObject(result) ||
    !Array.isArray(result.data) ||
    !result.data.every(
      (model) => isObject(model) && typeof model.id === "string",
    ) ||
    !(
      result.nextCursor === undefined ||
      result.nextCursor === null ||
      typeof result.nextCursor === "string"
    )
  )
    return "ModelListResponseChanged";
  return null;
};

export const compatibilityVersion = (version: unknown) =>
  typeof version === "string" &&
  /^\d+\.\d+\.\d+[a-zA-Z0-9.+-]{0,60}$/.test(version)
    ? version
    : null;
