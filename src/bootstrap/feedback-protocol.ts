import {
  createObserver,
  type ObservationEvent,
} from "../infra/codex/observe.ts";
import type { Direction } from "../infra/codex/relay.ts";
import {
  isShapePath,
  messageOfShape,
  type ShapePath,
  shapeKey,
} from "../infra/codex/shape.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";

export type RecordedShape = {
  direction: string;
  kind: string;
  method: string | null;
  paths: readonly ShapePath[];
};

type FixtureRecord = { direction: Direction; message: unknown };

// The shapes harnexus was tested on are those of the recorded app-server sessions under test/fixtures, read through the bridge's own observer so both sides are shaped alike.
export const fixtureShapes = (records: readonly FixtureRecord[]) => {
  const shapes: RecordedShape[] = [];
  const observer = createObserver(
    (event: ObservationEvent) => {
      if (event.event === "rpc_shape") {
        const { direction, kind, method, paths } = event;
        shapes.push({ direction, kind, method, paths });
      }
    },
    { shapes: "every" },
  );
  const encoder = new TextEncoder();
  for (const { direction, message } of records)
    observer.chunk(direction, encoder.encode(`${JSON.stringify(message)}\n`));
  observer.end("app_to_server");
  observer.end("server_to_app");
  return shapes;
};

export type ProtocolDiff = {
  covered: number;
  methods: number;
  changed: VariantChange[];
  newVariants: readonly string[];
  uncovered: readonly string[];
  unseen: readonly RecordedShape[];
};

export type VariantChange = {
  method: string;
  added: readonly ShapePath[];
  filled: readonly ShapePath[];
  missing: readonly ShapePath[];
};

// A method carries variants told apart by the type of the object it carries, such as each item type of item/started, so each variant is compared with the fixtures' shapes of the same variant.
// Only a method the fixtures hold can be compared, so one they lack is listed by name rather than flagged, as is a variant they lack.
// A field the fixtures hold only empty or null is told apart from a new one, since a recorded session may just not have filled it; a field every fixture shape of the variant has, where no recorded one has anything, is missing.
export const diffShapes = (
  observed: readonly RecordedShape[],
  baseline: readonly RecordedShape[],
): ProtocolDiff => {
  const known = groupVariants(baseline);
  const knownShapes = new Set(baseline.map(({ paths }) => shapeKey(paths)));
  const seen = groupVariants(observed);
  const changed: VariantChange[] = [];
  const newVariants: string[] = [];
  const uncovered: string[] = [];
  const changedVariants = new Set<string>();
  for (const [group, variants] of seen) {
    const tested = known.get(group);
    if (tested === undefined) {
      uncovered.push(group);
      continue;
    }
    for (const [variant, shapes] of variants) {
      const fixtures = tested.get(variant);
      const name = `${group} ${variant === "" ? "(no type)" : variant}`;
      if (fixtures === undefined) {
        newVariants.push(name);
        changedVariants.add(`${group}|${variant}`);
        continue;
      }
      const fixturePaths = union(fixtures);
      const observedPaths = union(shapes);
      const extra = [...observedPaths].filter(
        (path) => !fixturePaths.has(path),
      );
      const filled = extra.filter((path) => heldEmpty(path, fixturePaths));
      const added = extra.filter((path) => !heldEmpty(path, fixturePaths));
      const reached = new Set([...observedPaths].flatMap(locationsOf));
      const missing = [...intersection(fixtures)].filter(
        (path) => !observedPaths.has(path) && !reached.has(locationOf(path)),
      );
      if (added.length + filled.length + missing.length === 0) continue;
      changedVariants.add(`${group}|${variant}`);
      changed.push({
        method: name,
        added: added.sort(),
        filled: filled.sort(),
        missing: missing.sort(),
      });
    }
  }
  const unseen = unique(observed).filter(
    (shape) =>
      changedVariants.has(`${groupOf(shape)}|${variantOf(shape)}`) &&
      !knownShapes.has(shapeKey(shape.paths)),
  );
  return {
    covered: seen.size - uncovered.length,
    methods: seen.size,
    changed: changed.sort((a, b) => a.method.localeCompare(b.method)),
    newVariants: newVariants.sort(),
    uncovered: uncovered.sort(),
    unseen,
  };
};

// Every line counts against the budget, so a log with many shapes cannot push a report past what an issue takes.
export const formatProtocol = (
  diff: ProtocolDiff | null,
  budget: number,
): string[] => {
  if (diff === null) return ["No shapes recorded by the bridges in the report"];
  const summary = [
    `${diff.methods} methods seen by the bridges in the report; the fixtures hold ${diff.covered} of them`,
    ...(diff.changed.length === 0 && diff.newVariants.length === 0
      ? ["Every recorded variant of those methods matches the fixtures"]
      : []),
  ];
  const changes = diff.changed.map(
    ({ method, added, filled, missing }) =>
      `Differs from the fixtures in ${method}: ${[
        added.length > 0 && `new ${listed(added)}`,
        filled.length > 0 &&
          `filled where the fixtures hold only empty or null ${listed(filled)}`,
        missing.length > 0 && `missing ${listed(missing)}`,
      ]
        .filter((part) => part !== false)
        .join("; ")}`,
  );
  const names = [
    ...(diff.newVariants.length > 0
      ? [`Variants the fixtures do not hold: ${listed(diff.newVariants)}`]
      : []),
    ...(diff.uncovered.length > 0
      ? [`Methods the fixtures do not hold: ${listed(diff.uncovered)}`]
      : []),
  ];
  const shapes = diff.unseen.map((shape) => JSON.stringify(shape));
  const out: string[] = [];
  let used = 0;
  let left = 0;
  const add = (line: string) => {
    if (used + line.length + 1 > budget) {
      left += 1;
      return;
    }
    out.push(line);
    used += line.length + 1;
  };
  for (const line of [...summary, ...changes, ...names]) add(line);
  if (shapes.length > 0) {
    add("");
    add("-- Shapes the fixtures lack, for bun run shape-fixture --");
    for (const shape of shapes) add(shape);
  }
  return left > 0
    ? [...out, `${left} more lines left out to fit an issue`]
    : out;
};

const listed = (items: readonly string[]) =>
  items.length > MAX_LISTED
    ? `${items.slice(0, MAX_LISTED).join(", ")} and ${items.length - MAX_LISTED} more`
    : items.join(", ");

const MAX_LISTED = 20;

const groupOf = ({ direction, kind, method }: RecordedShape) =>
  `${direction} ${kind} ${method ?? "unknown"}`;

// Only the type of the object a method carries tells its variants apart; type words deeper in, such as each command action's, are compared as fields.
const variantOf = ({ paths }: RecordedShape) =>
  paths.find((path) => VARIANT_TYPES.some((at) => path.startsWith(at))) ?? "";

const VARIANT_TYPES = [
  "params.item.type=",
  "params.msg.type=",
  "params.type=",
  "params.status.type=",
];

const groupVariants = (shapes: readonly RecordedShape[]) => {
  const groups = new Map<string, Map<string, RecordedShape[]>>();
  for (const shape of shapes) {
    const variants = groups.get(groupOf(shape)) ?? new Map();
    const variant = variantOf(shape);
    variants.set(variant, [...(variants.get(variant) ?? []), shape]);
    groups.set(groupOf(shape), variants);
  }
  return groups;
};

const union = (shapes: readonly RecordedShape[]) =>
  new Set(shapes.flatMap(({ paths }) => paths));

const intersection = (shapes: readonly RecordedShape[]) => {
  const [first, ...rest] = shapes;
  if (first === undefined) return new Set<ShapePath>();
  return new Set(
    first.paths.filter((path) =>
      rest.every(({ paths }) => paths.includes(path)),
    ),
  );
};

const locationOf = (path: ShapePath) => path.replace(/(?::[a-z]+|=.+)$/, "");

// The field itself and every container above it.
const locationsOf = (path: ShapePath) =>
  locationOf(path)
    .split(/(?=\.|\[\])/)
    .map((_, index, parts) => parts.slice(0, index + 1).join(""));

// A path below a container the fixtures hold only as empty or null, or the same field with another type, fills what the fixtures left unfilled.
const heldEmpty = (path: ShapePath, fixturePaths: ReadonlySet<ShapePath>) =>
  locationsOf(path).some((prefix) =>
    EMPTY_LEAVES.some((leaf) => fixturePaths.has(`${prefix}${leaf}`)),
  );

const EMPTY_LEAVES = [":null", ":array", ":object"];

const unique = (shapes: readonly RecordedShape[]) => {
  const byKey = new Map<string, RecordedShape>();
  for (const shape of shapes)
    byKey.set(`${groupOf(shape)} ${shapeKey(shape.paths)}`, shape);
  return [...byKey.values()];
};

// Each shape a report lists becomes a fixture line with placeholder values and an id of its own; a response is preceded by the request it answers, so the observer pairs them as in a session.
export const fixtureFromReport = (report: string) => {
  const records: { direction: string; message: unknown }[] = [];
  let id = FIXTURE_ID_BASE;
  for (const line of report.split("\n")) {
    const shape = readShapeLine(line.trim());
    if (shape === null) continue;
    const built = messageOfShape(shape.paths);
    // A method with more separators than a shape keeps as a word is rebuilt from the method the shape line names.
    const message =
      isObject(built) &&
      shape.method !== null &&
      (shape.kind === "request" || shape.kind === "notification")
        ? { ...built, method: shape.method }
        : built;
    if (
      (shape.kind === "response" || shape.kind === "error_response") &&
      isObject(message)
    ) {
      id += 1;
      records.push({
        direction:
          shape.direction === "server_to_app"
            ? "app_to_server"
            : "server_to_app",
        message: { id, method: shape.method ?? "unknown", params: {} },
      });
      records.push({ direction: shape.direction, message: { ...message, id } });
    } else if (shape.kind === "request" && isObject(message)) {
      id += 1;
      records.push({ direction: shape.direction, message: { ...message, id } });
    } else {
      records.push({ direction: shape.direction, message });
    }
  }
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
};

const readShapeLine = (line: string): RecordedShape | null => {
  if (!line.startsWith("{")) return null;
  const parsed = parseJson(line);
  if (parsed.isErr() || !isObject(parsed.value)) return null;
  const { direction, kind, method, paths } = parsed.value;
  if (direction !== "app_to_server" && direction !== "server_to_app")
    return null;
  if (typeof kind !== "string" || !Array.isArray(paths)) return null;
  return {
    direction,
    kind,
    method: typeof method === "string" && METHOD.test(method) ? method : null,
    paths: paths.filter(
      (path): path is string => typeof path === "string" && isShapePath(path),
    ),
  };
};

const FIXTURE_ID_BASE = 9000;
const METHOD = /^[a-zA-Z][a-zA-Z0-9/_]{0,120}$/;
