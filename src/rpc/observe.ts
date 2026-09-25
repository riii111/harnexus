import { Result } from "better-result";
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
    const parsed = Result.try(() => JSON.parse(text) as Json);
    if (parsed.isErr()) {
      record({ event: "rpc_unobserved", direction, reason: "invalid_json" });
      return;
    }
    const message = parsed.value;
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
    const tools: ToolDefinition[] = [];
    collectTools(message, null, 0, tools);
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

// Tools grouped under a namespace ({ name, tools: [...] }) are recorded as "namespace.tool".
const collectTools = (
  value: Json,
  namespace: string | null,
  depth: number,
  found: ToolDefinition[],
) => {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) collectTools(item, namespace, depth + 1, found);
    return;
  }
  if (!isObject(value)) return;
  const name = typeof value.name === "string" ? value.name : null;
  if (name !== null && "inputSchema" in value) {
    const qualified = namespace === null ? name : `${namespace}.${name}`;
    found.push({
      name: identifier(qualified),
      inputSchema: sanitizeSchema(value.inputSchema ?? null, 0),
    });
    return;
  }
  const inner = name !== null && Array.isArray(value.tools) ? name : namespace;
  for (const child of Object.values(value)) {
    collectTools(child, inner, depth + 1, found);
  }
};

// Descriptions, defaults and examples are dropped because they can carry arbitrary text.
const sanitizeSchema = (value: Json, depth: number): SchemaShape => {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === "string") return identifier(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSchema(item, depth + 1));
  }
  if (!isObject(value)) return value;
  const shape: { [key: string]: SchemaShape } = {};
  for (const [key, child] of Object.entries(value)) {
    if (!SCHEMA_KEYS.has(key)) continue;
    if (SCHEMA_MAP_KEYS.has(key) && isObject(child)) {
      const entries: { [key: string]: SchemaShape } = {};
      for (const [name, schema] of Object.entries(child)) {
        if (IDENTIFIER.test(name)) {
          entries[name] = sanitizeSchema(schema, depth + 1);
        }
      }
      shape[key] = entries;
    } else {
      shape[key] = sanitizeSchema(child, depth + 1);
    }
  }
  return shape;
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

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const decoder = new TextDecoder();
const IDENTIFIER = /^[A-Za-z0-9_$.:/-]{1,128}$/;
const REDACTED = "<redacted>";
const MAX_DEPTH = 32;
const MAX_PENDING_REQUESTS = 10_000;

const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
]);
const SCHEMA_KEYS = new Set([
  ...SCHEMA_MAP_KEYS,
  "type",
  "required",
  "items",
  "prefixItems",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "enum",
  "const",
  "format",
  "$ref",
  "nullable",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
]);
