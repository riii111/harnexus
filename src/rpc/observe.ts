import { parseJson } from "../boundary/json.ts";
import { createLineSplitter } from "./line-splitter.ts";

export type Direction = "app_to_server" | "server_to_app";

// Only identifiers and structural schema reach an event, so params, conversations, code and credentials never do.
export type ObservationEvent =
  | {
      event: "rpc_message";
      direction: Direction;
      kind: MessageKind;
      method: string | null;
      id: RequestId | null;
      tools: readonly ToolDefinition[];
    }
  | { event: "rpc_unobserved"; direction: Direction; reason: UnobservedReason };

type MessageKind = "request" | "notification" | "response" | "error_response";

type UnobservedReason =
  | "invalid_json"
  | "not_object"
  | "unknown_shape"
  | "too_large";

type RequestId = string | number;

type ToolDefinition = { name: string; inputSchema: SchemaShape };

type SchemaShape =
  | boolean
  | string
  | number
  | null
  | SchemaShape[]
  | { [key: string]: SchemaShape };

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

// The relayed bytes are never altered; this only reads a copy of each chunk.
export const createObserver = (
  record: (event: ObservationEvent) => void,
  { maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {},
) => {
  const requests = createRequestTracker();

  const observeLine = (direction: Direction, bytes: Uint8Array) => {
    const text = decoder.decode(bytes);
    if (text.trim() === "") return;
    const parsed = parseJson(text);
    if (parsed.isErr()) {
      record({ event: "rpc_unobserved", direction, reason: "invalid_json" });
      return;
    }
    // JSON.parse only produces JSON values.
    const message = parsed.value as Json;
    if (!isObject(message)) {
      record({ event: "rpc_unobserved", direction, reason: "not_object" });
      return;
    }
    const kind = classify(message);
    if (kind === null) {
      record({ event: "rpc_unobserved", direction, reason: "unknown_shape" });
      return;
    }
    const id = requestId(message.id);
    const method =
      kind === "response" || kind === "error_response"
        ? requests.answer(direction, id)
        : identifier(String(message.method));
    if (kind === "request") requests.remember(direction, id, method);
    const tools = toolDefinitions(kind, method, message);
    record({ event: "rpc_message", direction, kind, method, id, tools });
  };

  const splitterFor = (direction: Direction) =>
    createLineSplitter(maxLineBytes, (line) => {
      if (line.kind === "oversized") {
        record({ event: "rpc_unobserved", direction, reason: "too_large" });
      } else {
        observeLine(direction, line.bytes);
      }
    });
  const splitters = {
    app_to_server: splitterFor("app_to_server"),
    server_to_app: splitterFor("server_to_app"),
  };

  return {
    chunk: (direction: Direction, chunk: Uint8Array) => {
      splitters[direction].push(chunk);
    },
    end: (direction: Direction) => {
      splitters[direction].end();
    },
  };
};

// Responses carry only an id, so the method comes from the request sent the other way; the map is bounded because some requests are never answered.
const createRequestTracker = () => {
  const pending = new Map<string, string>();
  const key = (direction: Direction, id: RequestId) =>
    `${direction}:${typeof id}:${id}`;
  return {
    remember: (
      direction: Direction,
      id: RequestId | null,
      method: string | null,
    ) => {
      if (id === null || method === null) return;
      if (pending.size >= MAX_PENDING_REQUESTS) {
        const oldest = pending.keys().next();
        if (!oldest.done) pending.delete(oldest.value);
      }
      pending.set(key(direction, id), method);
    },
    answer: (direction: Direction, id: RequestId | null) => {
      if (id === null) return null;
      const requestKey = key(opposite(direction), id);
      const method = pending.get(requestKey) ?? null;
      pending.delete(requestKey);
      return method;
    },
  };
};

const classify = (message: JsonObject): MessageKind | null => {
  if (typeof message.method === "string") {
    return "id" in message ? "request" : "notification";
  }
  if (!("id" in message)) return null;
  if ("error" in message) return "error_response";
  if ("result" in message) return "response";
  return null;
};

// Only the fields the app-server protocol defines for tool definitions are read, so a { name, inputSchema } inside arguments or other bodies is never recorded.
const toolDefinitions = (
  kind: MessageKind,
  method: string | null,
  message: JsonObject,
): ToolDefinition[] => {
  if (kind === "request" && method === "thread/start") {
    const params = asObject(message.params);
    return dynamicTools(asArray(params?.dynamicTools), null);
  }
  if (kind === "response" && method === "mcpServerStatus/list") {
    const servers = asArray(asObject(message.result)?.data);
    return servers.flatMap((server) => mcpServerTools(asObject(server)));
  }
  return [];
};

// A namespace spec ({ name, tools: [...] }) prefixes its tools as "namespace.tool".
const dynamicTools = (
  specs: Json[],
  namespace: string | null,
): ToolDefinition[] =>
  specs.flatMap((value) => {
    const spec = asObject(value);
    if (typeof spec?.name !== "string") return [];
    const name = namespace === null ? spec.name : `${namespace}.${spec.name}`;
    if (Array.isArray(spec.tools)) return dynamicTools(spec.tools, name);
    return [toolDefinition(name, spec.inputSchema)];
  });

const mcpServerTools = (server: JsonObject | null): ToolDefinition[] => {
  const tools = asObject(server?.tools);
  if (tools === null || typeof server?.name !== "string") return [];
  const serverName = server.name;
  return Object.values(tools).flatMap((value) => {
    const tool = asObject(value);
    if (typeof tool?.name !== "string") return [];
    return [toolDefinition(`${serverName}.${tool.name}`, tool.inputSchema)];
  });
};

const toolDefinition = (
  name: string,
  inputSchema: Json | undefined,
): ToolDefinition => ({
  name: identifier(name),
  inputSchema: sanitizeSchema(inputSchema ?? null, 0),
});

// Only structural keywords are kept: literal values (enum, const, default, examples) and free text (description, title, pattern) can carry arbitrary data even in a legitimate tool definition.
const sanitizeSchema = (value: Json, depth: number): SchemaShape => {
  if (typeof value === "boolean") return value;
  if (!isObject(value) || depth > MAX_DEPTH) return REDACTED;
  const shape: { [key: string]: SchemaShape } = {};
  for (const [key, child] of Object.entries(value)) {
    const kept = sanitizeKeyword(key, child, depth + 1);
    if (kept !== undefined) shape[key] = kept;
  }
  return shape;
};

const sanitizeKeyword = (
  key: string,
  value: Json,
  depth: number,
): SchemaShape | undefined => {
  switch (key) {
    case "type":
      return schemaTypes(value);
    case "required":
      return asArray(value).filter(
        (name): name is string =>
          typeof name === "string" && IDENTIFIER.test(name),
      );
    case "$ref":
      return typeof value === "string" && LOCAL_REF.test(value)
        ? value
        : undefined;
    case "nullable":
      return typeof value === "boolean" ? value : undefined;
    case "enum":
    case "const":
      return REDACTED;
    case "properties":
    case "definitions":
    case "$defs":
      return schemaMap(value, depth);
    case "items":
    case "additionalProperties":
    case "not":
      return Array.isArray(value)
        ? value.map((item) => sanitizeSchema(item, depth))
        : sanitizeSchema(value, depth);
    case "prefixItems":
    case "anyOf":
    case "oneOf":
    case "allOf":
      return asArray(value).map((item) => sanitizeSchema(item, depth));
    default:
      return undefined;
  }
};

const schemaTypes = (value: Json): SchemaShape | undefined => {
  if (typeof value === "string") {
    return SCHEMA_TYPES.has(value) ? value : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (type): type is string =>
      typeof type === "string" && SCHEMA_TYPES.has(type),
  );
};

const schemaMap = (value: Json, depth: number): SchemaShape | undefined => {
  if (!isObject(value)) return undefined;
  const entries: { [key: string]: SchemaShape } = {};
  for (const [name, schema] of Object.entries(value)) {
    if (IDENTIFIER.test(name)) entries[name] = sanitizeSchema(schema, depth);
  }
  return entries;
};

const requestId = (value: Json | undefined): RequestId | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return identifier(value);
  return null;
};

const identifier = (value: string) =>
  IDENTIFIER.test(value) ? value : REDACTED;

const opposite = (direction: Direction): Direction =>
  direction === "app_to_server" ? "server_to_app" : "app_to_server";

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asObject = (value: Json | undefined) => (isObject(value) ? value : null);

const asArray = (value: Json | undefined) =>
  Array.isArray(value) ? value : [];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const decoder = new TextDecoder();
const IDENTIFIER = /^[A-Za-z0-9_$.:/-]{1,128}$/;
const REDACTED = "<redacted>";
const MAX_DEPTH = 32;
const MAX_PENDING_REQUESTS = 10_000;

const LOCAL_REF = /^#\/(definitions|\$defs)\/[A-Za-z0-9_$.:-]{1,128}$/;
const SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);
