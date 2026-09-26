import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

let dir: string;
let reports: Map<string, Reported[]>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-lint-"));
  reports = await lintAll(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("testing lint rules", () => {
  test.each<{ name: string; source: string; expected: Reported[] }>([
    {
      name: "a nested describe",
      source: lintCase(`describe("outer", () => {
  describe("inner", () => {});
});`),
      expected: [{ line: 2, rule: NESTED }],
    },
    {
      name: "a describe.each nested in a describe",
      source: lintCase(`describe("outer", () => {
  describe.each([{ name: "a" }])("inner $name", () => {});
});`),
      expected: [{ line: 2, rule: NESTED }],
    },
    {
      name: "tuple rows with a positional specifier",
      source: lintCase(`test.each([
  ["a", 1],
])("does %s", (_label, n) => {});`),
      expected: [
        { line: 2, rule: TUPLE },
        { line: 3, rule: SPECIFIER },
      ],
    },
    {
      name: "object rows whose title embeds no property",
      source: lintCase(
        `test.each([{ name: "a" }])("does something", () => {});`,
      ),
      expected: [{ line: 1, rule: MISSING_NAME }],
    },
    {
      name: "tests registered in a for loop",
      source: lintCase(`for (const name of ["a", "b"]) {
  test(name, () => {});
}`),
      expected: [{ line: 1, rule: LOOP }],
    },
    {
      name: "tests registered in forEach",
      source: lintCase(`["a"].forEach((name) => {
  test(name, () => {});
});`),
      expected: [{ line: 1, rule: LOOP }],
    },
    {
      name: "typed tuple rows with a positional specifier",
      source: lintCase(
        `test.each<[string, number]>([["a", 1]])("does %s", () => {});`,
      ),
      expected: [
        { line: 1, rule: TUPLE },
        { line: 1, rule: SPECIFIER },
      ],
    },
    {
      name: "typed object rows whose title embeds no property",
      source: lintCase(
        `test.each<{ name: string }>([{ name: "a" }])("does something", () => {});`,
      ),
      expected: [{ line: 1, rule: MISSING_NAME }],
    },
    {
      name: "a typed describe.each nested in a describe",
      source: lintCase(`describe("outer", () => {
  describe.each<{ name: string }>([{ name: "a" }])("inner $name", () => {});
});`),
      expected: [{ line: 2, rule: NESTED }],
    },
    {
      name: "a describe with a timeout nested in a describe",
      source: lintCase(`describe("outer", () => {
  describe("inner", () => {}, 1000);
});`),
      expected: [{ line: 2, rule: NESTED }],
    },
    {
      name: "a test.each registered in a loop",
      source: lintCase(`for (const name of ["a"]) {
  test.each([{ name }])("does $name", () => {});
}`),
      expected: [{ line: 1, rule: LOOP }],
    },
    {
      name: "a template title without substitutions that embeds no property",
      source: lintCase(
        'test.each([{ name: "a" }])(`does something`, () => {});',
      ),
      expected: [{ line: 1, rule: MISSING_NAME }],
    },
    {
      name: "a template title without substitutions that uses a positional specifier",
      source: lintCase('test.each([{ name: "a" }])(`does %s`, () => {});'),
      expected: [{ line: 1, rule: SPECIFIER }],
    },
    {
      name: "a focused test",
      source: lintCase(`test.only("a", () => {});`),
      expected: [{ line: 1, rule: "lint/suspicious/noFocusedTests" }],
    },
    {
      name: "a skipped test",
      source: lintCase(`test.skip("a", () => {});`),
      expected: [{ line: 1, rule: "lint/suspicious/noSkippedTests" }],
    },
  ])("reports $name", ({ source, expected }) => {
    const diagnostics = reports.get(source);

    expect(diagnostics).toEqual(expected);
  });

  test.each([
    {
      name: "side-by-side describe blocks",
      source: lintCase(`describe("a", () => {});
describe("b", () => {});`),
    },
    {
      name: "a scenario loop inside a test",
      source: lintCase(`test("a", () => {
  for (const value of [1, 2]) expect(value).toBeGreaterThan(0);
});`),
    },
    {
      name: "typed object rows with a timeout",
      source:
        lintCase(`test.each<{ name: string; args: string[] }>([{ name: "a", args: [] }])(
  "hands $name",
  ({ args }) => {
    expect(args).toEqual([]);
  },
  1000,
);`),
    },
    {
      name: "a title that embeds the input value itself",
      source: lintCase(
        `test.each([{ signal: "SIGTERM" }])("forwards $signal", () => {});`,
      ),
    },
    {
      name: "a title passed through a variable",
      source: lintCase(`const title = "does $name";
test.each([{ name: "a" }])(title, () => {});`),
    },
    {
      name: "a template title whose substitution the lint cannot read",
      source: lintCase(`const format = (text: string) => text.length;
test.each([{ name: "a" }])(\`\${format("%s")} $name\`, () => {});`),
    },
    {
      name: "an escaped percent sign before a specifier letter",
      source: lintCase(
        `test.each([{ name: "a" }])("does $name with %%s", () => {});`,
      ),
    },
    {
      name: "a percent sign in a plain test title",
      source: lintCase(`test("keeps 100% of bytes", () => {});`),
    },
  ])("allows $name", ({ source }) => {
    const diagnostics = reports.get(source);

    expect(diagnostics).toEqual([]);
  });
});

const NESTED =
  "Do not nest describe blocks. Split them side by side, named after the target.";
const KEEP_INLINE =
  " Keep the table and title inline instead of moving them to a variable.";
const TUPLE = `Use object rows with a name instead of tuple rows.${KEEP_INLINE}`;
const SPECIFIER = `Embed a row property such as $name instead of a positional specifier.${KEEP_INLINE}`;
const MISSING_NAME = `Embed a row property such as $name in the title so each case is named.${KEEP_INLINE}`;
const LOOP = "Register parametrized tests with test.each instead of a loop.";
const TARGET_CATEGORIES = new Set([
  "plugin",
  "lint/suspicious/noFocusedTests",
  "lint/suspicious/noSkippedTests",
]);
const ROOT = join(import.meta.dir, "..");
const BIOME = join(ROOT, "node_modules", ".bin", "biome");

type Reported = { line: number; rule: string };

type Diagnostic = {
  category: string;
  message: string;
  location: { path: string; start: { line: number; column: number } };
};

const sources: string[] = [];

// Rows are built before beforeAll runs, so every case is known when the single lint pass starts.
const lintCase = (source: string) => {
  sources.push(source);
  return source;
};

// The files sit outside the repository so Bun never collects them, and the repository config is applied explicitly.
const lintAll = async (target: string) => {
  const files = new Map(
    sources.map((source, index) => [`case-${index}.test.ts`, source]),
  );
  await Promise.all(
    [...files].map(([file, source]) =>
      writeFile(
        join(target, file),
        `import { describe, expect, test } from "bun:test";\n${source}\n`,
      ),
    ),
  );
  const proc = Bun.spawn(
    [
      BIOME,
      "lint",
      `--config-path=${ROOT}`,
      "--reporter=json",
      "--max-diagnostics=none",
      target,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const report = JSON.parse(await new Response(proc.stdout).text()) as {
    diagnostics: Diagnostic[];
  };
  await proc.exited;
  const reports = new Map(sources.map((source) => [source, [] as Reported[]]));
  for (const diagnostic of report.diagnostics.sort(byPosition)) {
    const source = files.get(basename(diagnostic.location.path));
    if (source !== undefined && TARGET_CATEGORIES.has(diagnostic.category)) {
      reports.get(source)?.push(toReported(diagnostic));
    }
  }
  return reports;
};

const byPosition = (a: Diagnostic, b: Diagnostic) =>
  a.location.start.line - b.location.start.line ||
  a.location.start.column - b.location.start.column;

const toReported = (diagnostic: Diagnostic) => ({
  // The import line is prepended, so source lines start at 2.
  line: diagnostic.location.start.line - 1,
  rule:
    diagnostic.category === "plugin" ? diagnostic.message : diagnostic.category,
});
