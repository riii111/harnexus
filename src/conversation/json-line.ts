import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";

export const parseMessage = (line: Buffer) => {
  const parsed = parseJson(line.toString("utf8"));
  return parsed.isOk() && isObject(parsed.value) ? parsed.value : null;
};

export const encode = (message: object) =>
  Buffer.from(`${JSON.stringify(message)}\n`);

export const encodeWithoutParams = (
  message: Record<string, unknown>,
  params: Record<string, unknown>,
  omitted: readonly string[],
) =>
  encode({
    ...message,
    params: Object.fromEntries(
      Object.entries(params).filter(([key]) => !omitted.includes(key)),
    ),
  });
