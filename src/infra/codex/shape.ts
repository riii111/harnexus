// A message's shape is the sorted set of its paths, each ending in the type found there, so two shapes differ exactly where a field was added, moved or retyped.
// Keys are kept only when they look like the protocol's own field names; any other key, such as a path, an environment variable or a header, prints as <key>, and values print only as their type.
// A discriminator keeps its value when it is a plain camelCase word, since an item or status type tells variants of one method apart; only the top-level method keeps a value with separators.
// Tool arguments and results, configuration and schemas are the user's own data, so below them only the type is kept.
export type ShapePath = string;

// The walk visits a bounded number of values, since it runs on the relay's path before each line is passed on.
export const shapeOf = (value: unknown): ShapePath[] => {
  const paths = new Set<ShapePath>();
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
      const field = !isMap && FIELD_NAME.test(name) ? name : "<key>";
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

const isDiscriminator = (at: string, key: string, value: string) =>
  at === "" && key === "method"
    ? METHOD_WORD.test(value)
    : DISCRIMINATORS.has(key) && PLAIN_WORD.test(value);

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

// One shape stands for every message with the same paths, so a bridge records it once.
export const shapeKey = (paths: readonly ShapePath[]) =>
  Bun.hash(paths.join("\n")).toString(16).padStart(16, "0");

// Only a path the walk could have written passes, so a log edited by hand or a pasted report cannot carry text, a file path or an odd key through it.
export const isShapePath = (path: string) =>
  path.length <= MAX_PATH_CHARS && SHAPE_PATH.test(path);

// Builds a message with placeholder values that has the given shape, so a shape from a report can be replayed in a test; each array element variant gets an element of its own.
// The input may come from a pasted report, so only shape paths are read, and their field names cannot reach an object's prototype.
export const messageOfShape = (paths: readonly ShapePath[]): unknown => {
  let message: unknown;
  for (const path of paths) {
    if (!isShapePath(path)) continue;
    const matched = /^(.*?)(?::([a-z]+)|=(.+))$/.exec(path);
    if (matched === null) continue;
    const [, at = "", type = "", word] = matched;
    const steps = at === "" ? [] : stepsOf(at);
    const leaf = word ?? placeholder(type, steps.at(-1) ?? "");
    message = assign(message, steps, leaf);
  }
  return message ?? {};
};

const assign = (
  current: unknown,
  steps: readonly string[],
  leaf: unknown,
): unknown => {
  const [step, ...rest] = steps;
  if (step === undefined) return current === undefined ? leaf : current;
  if (step === "[]") {
    const list: unknown[] = Array.isArray(current) ? current : [];
    const index = list.findIndex((item) => canHold(item, rest, leaf));
    const at = index === -1 ? list.length : index;
    list[at] = assign(list[at], rest, leaf);
    return list;
  }
  const record: Record<string, unknown> = isRecord(current) ? current : {};
  record[step] = assign(record[step], rest, leaf);
  return record;
};

// An element already holding another value or type at the path cannot take it, so the variant goes to a new element.
const canHold = (
  item: unknown,
  steps: readonly string[],
  leaf: unknown,
): boolean => {
  if (item === undefined) return true;
  const [step, ...rest] = steps;
  if (step === undefined) return item === leaf;
  if (step === "[]") return Array.isArray(item);
  return isRecord(item) && canHold(item[step], rest, leaf);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stepsOf = (at: string) =>
  at.split(/(\[\])|\./).filter((step) => step !== undefined && step !== "");

// A discriminator's string placeholder is not a plain word, so the rebuilt message shapes back to the same path.
const placeholder = (type: string, key: string): unknown => {
  switch (type) {
    case "string":
      return DISCRIMINATORS.has(key) ? "X X" : "x";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
};

// The protocol names fields in camelCase, with a few in snake_case.
const FIELD_NAME = /^[a-z][a-zA-Z0-9]{0,40}(?:_[a-z0-9]{1,20}){0,4}$/;
const PLAIN_WORD = /^[a-z][a-zA-Z]{0,40}$/;
const METHOD_WORD = /^[a-zA-Z][a-zA-Z0-9]{0,40}(?:[/_][a-zA-Z0-9]{1,40}){0,8}$/;
const SEGMENT = "(?:[a-z][a-zA-Z0-9]{0,40}(?:_[a-z0-9]{1,20}){0,4}|<key>)";
const FIELD_PATH = String.raw`${SEGMENT}(?:\[\])*(?:\.${SEGMENT}(?:\[\])*)*`;
const SHAPE_PATH = new RegExp(
  `^(?:method=${METHOD_WORD.source.slice(1, -1)}|(?:${FIELD_PATH})?:(?:string|number|boolean|null|array|object|deeper|unknown)|${FIELD_PATH}=${PLAIN_WORD.source.slice(1, -1)})$`,
);
const DISCRIMINATORS = new Set(["type", "kind", "status", "role"]);
// Objects under these fields are keyed by names the user picks, such as MCP servers, environment variables, headers and tool parameters.
const MAP_FIELDS = new Set([
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
