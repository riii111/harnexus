import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { API } from "typescript/unstable/async";

type Area = "bootstrap" | "conversation" | "presentation" | "infra" | "runtime";

type Exception = { from: string; to: string; reason: string; until: string };

// A pair listed here passes the area rules; the check fails once the reference disappears, so the list only shrinks.
const EXCEPTIONS: readonly Exception[] = [
  {
    from: "infra/codex/codex-link.ts",
    to: "conversation/models.ts",
    reason:
      "create_thread offers the Claude models, whose ids conversation/ owns",
    until: "RA-02",
  },
];

// Every area may use itself and runtime/; bootstrap/ alone may use bootstrap/.
const ALLOWED: Record<Area, readonly Area[]> = {
  bootstrap: ["bootstrap", "conversation", "presentation", "infra", "runtime"],
  conversation: ["conversation", "presentation", "infra", "runtime"],
  presentation: ["presentation", "runtime"],
  infra: ["infra", "runtime"],
  runtime: ["runtime"],
};

// Parsing JSON performs no I/O, so presentation/ may use it like any pure runtime helper.
const PURE_BOUNDARIES = new Set(["runtime/json.boundary.ts"]);

describe("dependency rules of src", () => {
  test("hold for every source file with only the listed exceptions", async () => {
    const references = await collectReferences(ROOT);

    const problems = checkDependencies(references, EXCEPTIONS);

    expect(problems).toEqual([]);
  });
});

describe("checkDependencies", () => {
  test.each([
    {
      name: "conversation code using presentation, infra and runtime",
      files: {
        "conversation/a.ts": `import { p } from "../presentation/p.ts";
import { c } from "../infra/codex/c.ts";
import { r } from "../runtime/r.ts";
export const a = [p, c, r];`,
        "presentation/p.ts": "export const p = 1;",
        "infra/codex/c.ts": "export const c = 1;",
        "runtime/r.ts": "export const r = 1;",
      },
    },
    {
      name: "bootstrap code using every area",
      files: {
        "bootstrap/main.ts": `import "../conversation/a.ts";
import "../presentation/p.ts";
import "../infra/thread-store.ts";
import "../runtime/r.ts";`,
        "conversation/a.ts": "export const a = 1;",
        "presentation/p.ts": "export const p = 1;",
        "infra/thread-store.ts": "export const s = 1;",
        "runtime/r.ts": "export const r = 1;",
      },
    },
    {
      name: "infra/codex code using infra/claude and the thread store",
      files: {
        "infra/codex/c.ts": `import { s } from "../claude/s.ts";
import { t } from "../thread-store.ts";
export const c = [s, t];`,
        "infra/claude/s.ts": "export const s = 1;",
        "infra/thread-store.ts": "export const t = 1;",
      },
    },
    {
      name: "presentation code using a pure runtime helper and the JSON boundary",
      files: {
        "presentation/p.ts": `import { o } from "../runtime/object.ts";
import { j } from "../runtime/json.boundary.ts";
export const p = [o, j];`,
        "runtime/object.ts": "export const o = 1;",
        "runtime/json.boundary.ts": "export const j = 1;",
      },
    },
    {
      name: "tests and testing helpers reaching any area",
      files: {
        "conversation/a.test.ts": `import "../bootstrap/main.ts";`,
        "infra/codex/testing/t.ts": `export { a } from "../../../conversation/a.ts";`,
        "bootstrap/main.ts": "export const m = 1;",
        "conversation/a.ts": "export const a = 1;",
      },
    },
  ])("allows $name", async ({ files }) => {
    const references = await collectReferences(await writeProject(files));

    const problems = checkDependencies(references, []);

    expect(problems).toEqual([]);
  });

  test.each([
    {
      name: "a value import from infra into conversation",
      files: {
        "infra/codex/c.ts": `import { a } from "../../conversation/a.ts";
export const c = a;`,
        "conversation/a.ts": "export const a = 1;",
      },
      expected: [
        "infra/codex/c.ts -> conversation/a.ts: infra/ may not reference conversation/",
      ],
    },
    {
      name: "a type-only import from runtime into presentation",
      files: {
        "runtime/r.ts": `import type { P } from "../presentation/p.ts";
export type R = P;`,
        "presentation/p.ts": "export type P = 1;",
      },
      expected: [
        "runtime/r.ts -> presentation/p.ts: runtime/ may not reference presentation/",
      ],
    },
    {
      name: "a re-export of infra/codex from infra/claude",
      files: {
        "infra/claude/s.ts": `export * from "../codex/c.ts";`,
        "infra/codex/c.ts": "export const c = 1;",
      },
      expected: [
        "infra/claude/s.ts -> infra/codex/c.ts: infra/claude/ may not reference infra/codex/",
      ],
    },
    {
      name: "a dynamic import of infra from presentation",
      files: {
        "presentation/p.ts": `export const load = () => import("../infra/thread-store.ts");`,
        "infra/thread-store.ts": "export const s = 1;",
      },
      expected: [
        "presentation/p.ts -> infra/thread-store.ts: presentation/ may not reference infra/",
      ],
    },
    {
      name: "an import type of bootstrap from conversation",
      files: {
        "conversation/a.ts": `export type M = typeof import("../bootstrap/main.ts");`,
        "bootstrap/main.ts": "export const m = 1;",
      },
      expected: [
        "conversation/a.ts -> bootstrap/main.ts: conversation/ may not reference bootstrap/",
      ],
    },
    {
      name: "an I/O boundary used from presentation",
      files: {
        "presentation/p.ts": `import { f } from "../runtime/fs.boundary.ts";
export const p = f;`,
        "runtime/fs.boundary.ts": "export const f = 1;",
      },
      expected: [
        "presentation/p.ts -> runtime/fs.boundary.ts: presentation/ may not reference an I/O boundary",
      ],
    },
  ])("reports a reference breaking the area rules through $name", async ({
    files,
    expected,
  }) => {
    const references = await collectReferences(await writeProject(files));

    const problems = checkDependencies(references, []);

    expect(problems).toEqual(expected);
  });

  test.each([
    {
      name: "source code using a testing helper",
      files: {
        "conversation/a.ts": `import { t } from "../infra/codex/testing/t.ts";
export const a = t;`,
        "infra/codex/testing/t.ts": "export const t = 1;",
      },
      expected: [
        "conversation/a.ts -> infra/codex/testing/t.ts: source code may not reference tests or testing helpers",
      ],
    },
    {
      name: "a reference that cannot be resolved",
      files: {
        "conversation/a.ts": `import "./missing.ts";`,
      },
      expected: ['conversation/a.ts -> "./missing.ts": cannot be resolved'],
    },
    {
      name: "a file placed directly under src",
      files: {
        "helpers.ts": "export const h = 1;",
      },
      expected: ["helpers.ts: lies outside the areas of src/"],
    },
    {
      name: "a reference to a file outside src",
      files: {
        "runtime/r.ts": `import { x } from "../../test/x.ts";
export const r = x;`,
        "../test/x.ts": "export const x = 1;",
      },
      expected: [
        "runtime/r.ts -> ../test/x.ts: target lies outside the areas of src/",
      ],
    },
  ])("reports $name", async ({ files, expected }) => {
    const references = await collectReferences(await writeProject(files));

    const problems = checkDependencies(references, []);

    expect(problems).toEqual(expected);
  });

  test.each([
    {
      name: "the listed reference",
      target: "conversation/models.ts",
      exception: EXCEPTION,
      expected: [],
    },
    {
      name: "a reference to a file other than the listed target",
      target: "conversation/route.ts",
      exception: EXCEPTION,
      expected: [
        "infra/codex/codex-link.ts -> conversation/route.ts: infra/ may not reference conversation/",
        "exception infra/codex/codex-link.ts -> conversation/models.ts is no longer needed",
      ],
    },
    {
      name: "a reference the area rules already allow",
      target: "runtime/object.ts",
      exception: { ...EXCEPTION, to: "runtime/object.ts" },
      expected: [
        "exception infra/codex/codex-link.ts -> runtime/object.ts is no longer needed",
      ],
    },
  ])("reports only what an exception leaves uncovered for $name", async ({
    target,
    exception,
    expected,
  }) => {
    const references = await collectReferences(
      await writeProject({
        "infra/codex/codex-link.ts": `import { m } from "${relative("infra/codex", target)}";
export const l = m;`,
        [target]: "export const m = 1;",
      }),
    );

    const problems = checkDependencies(references, [exception]);

    expect(problems).toEqual(expected);
  });
});

type Reference =
  | { kind: "file"; file: string }
  | { kind: "import"; from: string; specifier: string; to: string | undefined };

const ROOT = join(import.meta.dir, "..");
const AREAS = new Set<string>(Object.keys(ALLOWED));

// Paths are relative to src/; tests and testing helpers are exempt as sources but not as targets.
const checkDependencies = (
  references: readonly Reference[],
  exceptions: readonly Exception[],
): readonly string[] => {
  const problems: string[] = [];
  const used = new Set<Exception>();
  for (const reference of references) {
    if (reference.kind === "file") {
      if (areaOf(reference.file) === undefined)
        problems.push(`${reference.file}: lies outside the areas of src/`);
      continue;
    }
    const { from, specifier, to } = reference;
    if (to === undefined) {
      problems.push(`${from} -> "${specifier}": cannot be resolved`);
      continue;
    }
    const broken = brokenRule(from, to);
    if (broken === undefined) continue;
    const exception = exceptions.find((e) => e.from === from && e.to === to);
    if (exception === undefined) problems.push(`${from} -> ${to}: ${broken}`);
    else used.add(exception);
  }
  for (const exception of exceptions) {
    if (!used.has(exception))
      problems.push(
        `exception ${exception.from} -> ${exception.to} is no longer needed`,
      );
  }
  return problems;
};

const brokenRule = (from: string, to: string) => {
  const fromArea = areaOf(from);
  const toArea = areaOf(to);
  if (fromArea === undefined || toArea === undefined)
    return "target lies outside the areas of src/";
  if (isTestCode(to))
    return "source code may not reference tests or testing helpers";
  if (!ALLOWED[fromArea].includes(toArea))
    return `${fromArea}/ may not reference ${toArea}/`;
  if (
    fromArea === "presentation" &&
    to.endsWith(".boundary.ts") &&
    !PURE_BOUNDARIES.has(to)
  )
    return "presentation/ may not reference an I/O boundary";
  if (from.startsWith("infra/claude/") && to.startsWith("infra/codex/"))
    return "infra/claude/ may not reference infra/codex/";
  return undefined;
};

const areaOf = (path: string) => {
  const [first, ...rest] = path.split("/");
  return first !== undefined && rest.length > 0 && AREAS.has(first)
    ? (first as Area)
    : undefined;
};

const isTestCode = (path: string) =>
  path.endsWith(".test.ts") || path.split("/").includes("testing");

// Resolution goes through the checker, so extensionless and type-only specifiers resolve exactly as tsc sees them.
const collectReferences = async (root: string) => {
  const src = join(root, "src");
  const api = new API({ cwd: root });
  try {
    const snapshot = await api.updateSnapshot({
      openProject: join(root, "tsconfig.json"),
    });
    const project = snapshot.getProjects()[0];
    if (project === undefined) return [missingProject(root)];
    const names = await project.program.getSourceFileNames();
    // Declaration paths come back lowercased on a case-insensitive file system.
    const byPath = new Map(names.map((name) => [name.toLowerCase(), name]));
    const references: Reference[] = [];
    for (const file of await sourceFiles(src)) {
      const path = relative(src, file);
      references.push({ kind: "file", file: path });
      const source = await project.program.getSourceFile(file);
      if (source === undefined) {
        references.push({
          kind: "import",
          from: path,
          specifier: "(not in the TypeScript project)",
          to: undefined,
        });
        continue;
      }
      const symbols = await project.checker.getSymbolAtLocation([
        ...source.imports,
      ]);
      source.imports.forEach((node, index) => {
        const declared = symbols[index]?.declarations[0]?.path;
        const target =
          declared === undefined
            ? undefined
            : (byPath.get(declared.toLowerCase()) ?? declared);
        if (target !== undefined && isPackage(root, target)) return;
        references.push({
          kind: "import",
          from: path,
          specifier: "text" in node ? String(node.text) : "",
          to: target === undefined ? undefined : relative(src, target),
        });
      });
    }
    return references;
  } finally {
    await api.close();
  }
};

const isPackage = (root: string, target: string) => {
  const path = relative(root, target);
  return path.startsWith("..") || path.split("/").includes("node_modules");
};

const sourceFiles = async (src: string) => {
  const files: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: src })) {
    if (!isTestCode(path)) files.push(join(src, path));
  }
  return files.sort();
};

const missingProject = (root: string): Reference => ({
  kind: "import",
  from: relative(ROOT, root) || ".",
  specifier: "tsconfig.json",
  to: undefined,
});

const EXCEPTION: Exception = {
  from: "infra/codex/codex-link.ts",
  to: "conversation/models.ts",
  reason: "fixture",
  until: "RA-02",
};

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: "Preserve",
    moduleResolution: "Bundler",
    allowImportingTsExtensions: true,
    noEmit: true,
    types: [],
  },
  include: ["**/*.ts"],
});

let tmp: string;
let projects = 0;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "harnexus-deps-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// Each case gets its own project root, with the files placed relative to its src/.
const writeProject = async (files: Record<string, string>) => {
  projects += 1;
  const root = join(tmp, `project-${projects}`);
  const src = join(root, "src");
  await mkdir(src, { recursive: true });
  await writeFile(join(root, "tsconfig.json"), TSCONFIG);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(src, path)), { recursive: true });
    await writeFile(join(src, path), `${text}\n`);
  }
  return root;
};
