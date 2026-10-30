import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Print mode answers one object, or an array of events ending in its result.
export const printAnswer = (stdout: string): Record<string, unknown> | null => {
  const parsed = parseJson(stdout);
  if (parsed.isErr()) return null;
  if (!Array.isArray(parsed.value)) {
    return isObject(parsed.value) ? parsed.value : null;
  }
  const result = parsed.value
    .filter((event) => isObject(event) && event.type === "result")
    .at(-1);
  return isObject(result) ? result : null;
};
