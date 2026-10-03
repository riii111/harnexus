import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import { createLineSplitter } from "./line-splitter.ts";
import type { Direction, RelayObserver } from "./relay.ts";

// Records the shape of every relayed message, to learn how the app and the server talk in features the bridge does not cover yet.
// Text is replaced by its length and each id by a token kept for the whole trace, so the file shows which messages name the same thread or item without what anyone wrote; only values under keys that name a kind, such as type or status, stay as they are.
export const createTraceObserver = (
  write: (line: string) => void,
  now: () => number = Date.now,
  { maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {},
): RelayObserver => {
  const tokens = new Map<string, string>();
  const tokenOf = (value: string) => {
    const known = tokens.get(value);
    if (known !== undefined) return known;
    const token = `<id ${tokens.size + 1}>`;
    tokens.set(value, token);
    return token;
  };

  const shapeOf = (value: unknown, key: string | null): unknown => {
    if (typeof value === "string") {
      if (key !== null && KEPT_KEYS.has(key)) return value.slice(0, MAX_KEPT);
      if (key !== null && isIdKey(key)) return tokenOf(value);
      return `<text ${value.length}>`;
    }
    if (Array.isArray(value)) return value.map((item) => shapeOf(item, key));
    if (isObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [
          isFieldName(name) ? name : tokenOf(name),
          shapeOf(item, name),
        ]),
      );
    }
    return value;
  };

  const record = (direction: Direction, fields: object) =>
    write(`${JSON.stringify({ at: now(), direction, ...fields })}\n`);

  const splitterFor = (direction: Direction) =>
    createLineSplitter(maxLineBytes, (line) => {
      if (line.kind === "oversized") {
        record(direction, { oversized: true });
        return;
      }
      const text = decoder.decode(line.bytes);
      if (text.trim() === "") return;
      const parsed = parseJson(text);
      if (parsed.isErr()) {
        record(direction, { unparsed: true });
        return;
      }
      record(direction, { message: shapeOf(parsed.value, null) });
    });
  const splitters = {
    app_to_server: splitterFor("app_to_server"),
    server_to_app: splitterFor("server_to_app"),
  };

  return {
    chunk: (direction, chunk) => splitters[direction].push(chunk),
    end: (direction) => splitters[direction].end(),
  };
};

// Ids are named id, or end in Id or Ids, as in threadId or receiverThreadIds.
const isIdKey = (key: string) => key === "id" || /[a-z](Id|Ids)$/.test(key);

// Protocol field names are short camelCase or snake_case words; any other key, such as a thread id keying a map or a file path, is data.
const isFieldName = (key: string) => /^[A-Za-z_$][\w$]{0,63}$/.test(key);

const KEPT_KEYS = new Set([
  "method",
  "type",
  "kind",
  "status",
  "subtype",
  "tool",
  "phase",
  "itemsView",
  "role",
  "source",
  "sourceKinds",
  "activeFlags",
  "mode",
  "model",
  "reasoningEffort",
  "effort",
  "approvalPolicy",
  "sandbox",
  "threadSource",
  "server",
  "jsonrpc",
]);

const MAX_KEPT = 80;

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

const decoder = new TextDecoder();
