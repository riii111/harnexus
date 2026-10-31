import { PROTOCOL_FIELDS } from "./protocol-fields.ts";

// A message's shape is the sorted set of its paths, each ending in the type found there, so two shapes differ exactly where a field was added, moved or retyped.
// Keys are kept only when they are the protocol's own field names; any other key, such as a path, an environment variable, a header or a key the user picked, prints as <key>, and values print only as their type.
// A discriminator keeps its value when it is a plain camelCase word, since an item or status type tells variants of one method apart; only the top-level method keeps a value with separators.
// Tool arguments and results, configuration and schemas are the user's own data, so below them only the type is kept.
export type ShapePath = string;

export const shapeOf = (value: unknown): ShapePath[] => {
  const paths = new Set<ShapePath>();
  // The walk runs on the relay's path before each line is passed on, so it visits a bounded number of values.
  walk(value, "", "", 0, paths, { left: MAX_VISITS });
  const kept: ShapePath[] = [];
  let size = 0;
  for (const path of [...paths].sort().slice(0, MAX_PATHS)) {
    size += path.length + 1;
    if (size > MAX_SHAPE_CHARS) break;
    kept.push(path);
  }
  return kept;
};

const walk = (
  value: unknown,
  at: string,
  key: string,
  depth: number,
  paths: Set<ShapePath>,
  budget: { left: number },
): void => {
  budget.left -= 1;
  if (paths.size >= MAX_PATHS || budget.left < 0) return;
  if (depth > MAX_DEPTH) {
    paths.add(`${at}:deeper`);
    return;
  }
  if (
    OPAQUE_FIELDS.has(key) ||
    OPAQUE_PATHS.some((suffix) => at.endsWith(suffix)) ||
    at.length > MAX_PATH_CHARS - MAX_LEAF_CHARS
  ) {
    paths.add(`${at}:${typeName(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) paths.add(`${at}:array`);
    for (const item of value.slice(0, MAX_ITEMS))
      walk(item, `${at}[]`, key, depth + 1, paths, budget);
    return;
  }
  if (typeof value === "object" && value !== null) {
    // A key that is not a field name names the user's data unless it is a map entry, so below it only the type is kept.
    const isMap = MAP_FIELDS.has(key);
    let count = 0;
    // A for-in loop stops at the cap without listing every key of a very wide object first.
    for (const name in value) {
      if (!Object.hasOwn(value, name)) continue;
      count += 1;
      if (count > MAX_KEYS) break;
      const child = (value as Record<string, unknown>)[name];
      const field =
        !isMap && FIELD_NAME.test(name) && PROTOCOL_FIELDS.has(name)
          ? name
          : "<key>";
      const path = at === "" ? field : `${at}.${field}`;
      if (typeof child === "string" && isDiscriminator(at, name, child))
        paths.add(`${path}=${child}`);
      else if (field === "<key>" && !isMap)
        paths.add(`${path}:${typeName(child)}`);
      else walk(child, path, field, depth + 1, paths, budget);
    }
    if (count === 0) paths.add(`${at}:object`);
    return;
  }
  paths.add(`${at}:${typeName(value)}`);
};

const isDiscriminator = (at: string, key: string, value: string) => {
  if (at === "" && key === "method") return METHOD_WORD.test(value);
  if (!PLAIN_WORD.test(value)) return false;
  const place = `${at}.${key}`
    .replaceAll("[]", "")
    .replace(/^(?:params|result|error)\./, "");
  // A word under type, kind, status or role elsewhere, such as in a map entry or a user's own object, may be the user's value, so only these places keep it.
  return DISCRIMINATOR_PLACES.has(place);
};

const typeName = (value: unknown) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "unknown";
  }
};

export const shapeKey = (paths: readonly ShapePath[]) =>
  Bun.hash(paths.join("\n")).toString(16).padStart(16, "0");

export const isShapePath = (path: string) =>
  // Only a path the walk could have written passes, so a log edited by hand cannot carry text, a file path or an odd key through it.
  path.length <= MAX_PATH_CHARS && SHAPE_PATH.test(path);

// The protocol names fields in camelCase, with a few in snake_case.
const FIELD_NAME = /^[a-z][a-zA-Z0-9]{0,40}(?:_[a-z0-9]{1,20}){0,4}$/;
const PLAIN_WORD = /^[a-z][a-zA-Z]{0,40}$/;
const METHOD_WORD = /^[a-zA-Z][a-zA-Z0-9]{0,40}(?:[/_][a-zA-Z0-9]{1,40}){0,8}$/;
const SEGMENT = "(?:[a-z][a-zA-Z0-9]{0,40}(?:_[a-z0-9]{1,20}){0,4}|<key>)";
const FIELD_PATH = String.raw`${SEGMENT}(?:\[\])*(?:\.${SEGMENT}(?:\[\])*)*`;
const SHAPE_PATH = new RegExp(
  `^(?:method=${METHOD_WORD.source.slice(1, -1)}|(?:${FIELD_PATH})?:(?:string|number|boolean|null|array|object|deeper|unknown)|${FIELD_PATH}=${PLAIN_WORD.source.slice(1, -1)})$`,
);
// The places the protocol puts a type or status word, below params, result or error, with array steps left out.
const DISCRIMINATOR_PLACES = new Set([
  "kind",
  "status",
  "status.type",
  "type",
  "msg.type",
  "input.type",
  "dynamicTools.type",
  "commandActions.type",
  "contentItems.type",
  "sandbox.type",
  "item.type",
  "item.status",
  "item.role",
  "item.content.type",
  "item.contentItems.type",
  "item.commandActions.type",
  "item.changes.kind.type",
  "turn.status",
  "turn.items.type",
  "thread.status.type",
  "thread.turns.status",
  "thread.turns.items.type",
  "turns.status",
  "turns.items.type",
  "data.status.type",
]);
// Objects under these fields are keyed by names the user picks, such as MCP servers, environment variables, headers and tool parameters.
const MAP_FIELDS = new Set([
  "additionalContext",
  "env",
  "headers",
  "mcpServers",
  "mcp_servers",
  "servers",
  "tools",
  "properties",
  "definitions",
  "profiles",
  "projects",
]);
const OPAQUE_PATHS = ["result.content", "error.data"];
const OPAQUE_FIELDS = new Set([
  "value",
  "requestedSchema",
  "arguments",
  "structuredContent",
  "config",
  "inputSchema",
  "outputSchema",
  "annotations",
  "features",
]);
const MAX_DEPTH = 12;
const MAX_KEYS = 64;
const MAX_ITEMS = 64;
const MAX_PATHS = 400;
const MAX_VISITS = 20_000;
const MAX_PATH_CHARS = 600;
const MAX_LEAF_CHARS = 60;
const MAX_SHAPE_CHARS = 32_000;
