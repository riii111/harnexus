import {
  createObserver,
  type ObservationEvent,
} from "../infra/codex/observe.ts";
import type { Direction } from "../infra/codex/relay.ts";
import { type ShapePath, shapeKey } from "../infra/codex/shape.ts";

export type RecordedShape = {
  direction: string;
  kind: string;
  method: string | null;
  paths: readonly ShapePath[];
};

type FixtureRecord = { direction: Direction; message: unknown };

// The shapes harnexus was tested on: those of the recorded app-server sessions under test/fixtures.
export const fixtureShapes = (records: readonly FixtureRecord[]) => {
  const shapes: RecordedShape[] = [];
  // Read through the bridge's own observer so both sides are shaped alike.
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

type VariantChange = {
  method: string;
  recorded: number;
  added: readonly ShapePath[];
  filled: readonly ShapePath[];
  // How many of the recorded shapes lack each field.
  missing: readonly { path: ShapePath; lackedBy: number }[];
};

// Compares the shapes the bridges recorded with the fixtures' shapes, variant by variant.
export const diffShapes = (
  observed: readonly RecordedShape[],
  baseline: readonly RecordedShape[],
): ProtocolDiff => {
  const known = groupVariants(baseline);
  const knownShapes = new Set(baseline.map(shapeId));
  const seen = groupVariants(observed);
  const changed: VariantChange[] = [];
  const newVariants: string[] = [];
  const uncovered: string[] = [];
  const changedVariants = new Set<string>();
  for (const [group, variants] of seen) {
    const tested = known.get(group);
    // Only a method the fixtures hold can be compared, so one they lack is listed by name rather than flagged, as is a variant they lack.
    if (tested === undefined) {
      uncovered.push(group);
      continue;
    }
    // A method carries variants told apart by the type of the object it carries, such as each item type of item/started, so each variant is compared with the fixtures' shapes of the same variant.
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
      // A field the fixtures hold only empty or null is told apart from a new one, since a recorded session may just not have filled it.
      const filled = extra.filter((path) => heldEmpty(path, fixturePaths));
      const added = extra.filter((path) => !heldEmpty(path, fixturePaths));
      // A field every fixture shape of the variant has is counted missing shape by shape, so a complete message cannot hide an incomplete one.
      const required = [...intersection(fixtures)];
      const missing = required
        .map((path) => ({
          path,
          lackedBy: shapes.filter((shape) => lacks(shape, path)).length,
        }))
        .filter(({ lackedBy }) => lackedBy > 0);
      if (added.length + filled.length + missing.length === 0) continue;
      changedVariants.add(`${group}|${variant}`);
      changed.push({
        method: name,
        recorded: shapes.length,
        added: added.sort(),
        filled: filled.sort(),
        missing: missing.sort((a, b) => a.path.localeCompare(b.path)),
      });
    }
  }
  const unseen = unique(observed).filter(
    (shape) =>
      changedVariants.has(`${groupOf(shape)}|${variantOf(shape)}`) &&
      !knownShapes.has(shapeId(shape)),
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

// The protocol section of a report, within the budget.
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
    ({ method, recorded, added, filled, missing }) =>
      `Differs from the fixtures in ${method}: ${[
        added.length > 0 && `new ${listed(added)}`,
        filled.length > 0 &&
          `filled where the fixtures hold only empty or null ${listed(filled)}`,
        missing.length > 0 &&
          `missing ${listed(
            missing.map(({ path, lackedBy }) =>
              lackedBy === recorded
                ? path
                : `${path} (in ${lackedBy} of ${recorded} recorded shapes)`,
            ),
          )}`,
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
    // Every line counts against the budget, so a log with many shapes cannot push a report past what an issue takes.
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
    add("-- Shapes the fixtures lack --");
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

const variantOf = ({ paths }: RecordedShape) =>
  // Only the type of the object a method carries tells its variants apart; type words deeper in, such as each command action's, are compared as fields.
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

const placeOf = (path: ShapePath) => path.replace(/(?::[a-z]+|=.+)$/, "");

const pathPrefixes = (path: ShapePath) =>
  placeOf(path)
    .split(/(?=\.|\[\])/)
    .map((_, index, parts) => parts.slice(0, index + 1).join(""));

const lacks = (shape: RecordedShape, path: ShapePath) => {
  const place = placeOf(path);
  // A shape with anything at the field's place, such as the same field with another type, does not lack it.
  return !shape.paths.some((own) => pathPrefixes(own).includes(place));
};

const heldEmpty = (path: ShapePath, fixturePaths: ReadonlySet<ShapePath>) =>
  // A path below a container the fixtures hold only as empty or null, or the same field with another type, fills what the fixtures left unfilled.
  pathPrefixes(path).some((prefix) =>
    EMPTY_LEAVES.some((leaf) => fixturePaths.has(`${prefix}${leaf}`)),
  );

const EMPTY_LEAVES = [":null", ":array", ":object"];

const shapeId = (shape: RecordedShape) =>
  `${groupOf(shape)} ${shapeKey(shape.paths)}`;

const unique = (shapes: readonly RecordedShape[]) => [
  ...new Map(shapes.map((shape) => [shapeId(shape), shape])).values(),
];
