import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type Node, SyntaxKind } from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";

describe("dependency rules of src", () => {
  test("hold for every source file with only the listed exceptions", async () => {
    const references = await collectReferences(ROOT);

    const problems = checkDependencies(references, EXCEPTIONS);

    expect(problems).toEqual([]);
  });
});

describe("checkDependencies", () => {
  test("reports value, type-only, dynamic, import-type and re-export references breaking the area rules", async () => {
    const references = await collectReferences(
      await writeProject({
        "infra/codex/c.ts": `import { a } from "../../conversation/a.ts";
export const c = a;`,
        "lib/r.ts": `import type { P } from "../conversation/p.view.ts";
export type R = P;`,
        "infra/claude/s.ts": `export * from "../codex/c.ts";`,
        "conversation/p.view.ts": `export type P = 1;
export const load = () => import("../infra/thread-store.ts");`,
        "conversation/a.ts": `export const a = 1;
export type M = typeof import("../cli/bridge.ts");`,
        "infra/thread-store.ts": "export const s = 1;",
        "task/t.ts": `import { a } from "../conversation/a.ts";
export const t = a;`,
        "diagnostics/d.ts": `import { a } from "../conversation/a.ts";
export const d = a;`,
        "cli/bridge.ts": "export const m = 1;",
      }),
    );

    const problems = checkDependencies(references, []);

    expect(problems).toEqual([
      "conversation/a.ts -> cli/bridge.ts: conversation/ may not reference cli/",
      "conversation/p.view.ts -> infra/thread-store.ts: a view may reference only views, infra/codex/protocol/ and lib/",
      "diagnostics/d.ts -> conversation/a.ts: diagnostics/ may not reference conversation/",
      "infra/claude/s.ts -> infra/codex/c.ts: infra/claude/ may not reference infra/codex/",
      "infra/codex/c.ts -> conversation/a.ts: infra/ may not reference conversation/",
      "lib/r.ts -> conversation/p.view.ts: lib/ may not reference conversation/",
      "task/t.ts -> conversation/a.ts: task/ may not reference conversation/",
    ]);
  });

  test("reports conversation code outside claude/ referencing conversation/claude/", async () => {
    const references = await collectReferences(
      await writeProject({
        "conversation/controller.ts": `import { r } from "./claude/r.ts";
export const c = r;`,
        "conversation/claude/r.ts": "export const r = 1;",
      }),
    );

    const problems = checkDependencies(references, []);

    expect(problems).toEqual([
      "conversation/controller.ts -> conversation/claude/r.ts: conversation/ outside claude/ may not reference conversation/claude/",
    ]);
  });

  test("reports an I/O boundary used from a view", async () => {
    const references = await collectReferences(
      await writeProject({
        "conversation/p.view.ts": `import { f } from "../lib/fs.boundary.ts";
export const p = f;`,
        "lib/fs.boundary.ts": "export const f = 1;",
      }),
    );

    const problems = checkDependencies(references, []);

    expect(problems).toEqual([
      "conversation/p.view.ts -> lib/fs.boundary.ts: a view may not reference an I/O boundary",
    ]);
  });

  test("reports a view referencing a file other than views, the App protocol and pure lib helpers", async () => {
    const references = await collectReferences(
      await writeProject({
        "conversation/turn/t.view.ts": `import { h } from "../history/h.view.ts";
import { j } from "../../lib/json.boundary.ts";
import { m } from "../../infra/codex/protocol/m.ts";
import { c } from "./controller.ts";
export const t = [h, j, m, c];`,
        "conversation/history/h.view.ts": "export const h = 1;",
        "lib/json.boundary.ts": "export const j = 1;",
        "infra/codex/protocol/m.ts": "export const m = 1;",
        "conversation/turn/controller.ts": "export const c = 1;",
      }),
    );

    const problems = checkDependencies(references, []);

    expect(problems).toEqual([
      "conversation/turn/t.view.ts -> conversation/turn/controller.ts: a view may reference only views, infra/codex/protocol/ and lib/",
    ]);
  });

  test.each([
    {
      name: "a testing helper",
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
      name: "a file outside src",
      files: {
        "lib/r.ts": `import { x } from "../../test/x.ts";
export const r = x;`,
        "../test/x.ts": "export const x = 1;",
      },
      expected: [
        "lib/r.ts -> ../test/x.ts: target lies outside the areas of src/",
      ],
    },
  ])("reports a reference to $name", async ({ files, expected }) => {
    const references = await collectReferences(await writeProject(files));

    const problems = checkDependencies(references, []);

    expect(problems).toEqual(expected);
  });

  test.each([
    {
      name: "an import of a missing file",
      files: {
        "conversation/a.ts": `import "./missing.ts";`,
      },
      expected: ['conversation/a.ts -> "./missing.ts": cannot be resolved'],
    },
    {
      name: "a require call",
      files: {
        "lib/r.ts": `export const m = require("../conversation/m.ts");`,
        "conversation/m.ts": "export const m = 1;",
      },
      expected: [
        'lib/r.ts -> "require("../conversation/m.ts")": cannot be resolved',
      ],
    },
  ])("reports $name as unresolvable", async ({ files, expected }) => {
    const references = await collectReferences(await writeProject(files));

    const problems = checkDependencies(references, []);

    expect(problems).toEqual(expected);
  });

  test.each([
    { name: "a file directly under src", path: "helpers.ts" },
    { name: "a TSX file directly under src", path: "helpers.tsx" },
    { name: "a file in an unknown folder", path: "helpers/h.ts" },
  ])("reports $name as outside the areas", async ({ path }) => {
    const references = await collectReferences(
      await writeProject({ [path]: "export const h = 1;" }),
    );

    const problems = checkDependencies(references, []);

    expect(problems).toEqual([`${path}: lies outside the areas of src/`]);
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
        "link/codex-link.ts -> conversation/route.ts: link/ may not reference conversation/",
        "exception link/codex-link.ts -> conversation/models.ts is no longer needed",
      ],
    },
    {
      name: "a reference the area rules already allow",
      target: "lib/object.ts",
      exception: { ...EXCEPTION, to: "lib/object.ts" },
      expected: [
        "exception link/codex-link.ts -> lib/object.ts is no longer needed",
      ],
    },
  ])(
    "reports only what an exception leaves uncovered for $name",
    async ({ target, exception, expected }) => {
      const references = await collectReferences(
        await writeProject({
          "link/codex-link.ts": `import { m } from "${relative("link", target)}";
export const l = m;`,
          [target]: "export const m = 1;",
        }),
      );

      const problems = checkDependencies(references, [exception]);

      expect(problems).toEqual(expected);
    },
  );
});

type Area =
  | "cli"
  | "conversation"
  | "diagnostics"
  | "link"
  | "prwatch"
  | "task"
  | "infra"
  | "lib";

type Exception = { from: string; to: string; reason: string; until: string };

// A pair listed here passes the area rules; the check fails once the reference disappears, so the list only shrinks.
const EXCEPTIONS: readonly Exception[] = [];

const ALLOWED: Record<Area, readonly Area[]> = {
  cli: [
    "cli",
    "conversation",
    "diagnostics",
    "link",
    "prwatch",
    "task",
    "infra",
    "lib",
  ],
  conversation: ["conversation", "link", "infra", "lib"],
  diagnostics: ["diagnostics", "infra", "lib"],
  link: ["link", "infra", "lib"],
  // The PR watch stands apart from the conversation and is told how to reach workers, so it may be moved out whole.
  prwatch: ["prwatch", "infra", "lib"],
  // harnexus-task drives the PR watch, the thread links and the Claude and Codex CLIs, but knows nothing of the bridge's conversations.
  task: ["task", "link", "prwatch", "infra", "lib"],
  infra: ["infra", "lib"],
  lib: ["lib"],
};

// Parsing JSON performs no I/O, so a view may use it like any pure lib helper.
const PURE_BOUNDARIES = new Set(["lib/json.boundary.ts"]);

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
  // A source outside the areas is already reported as a file, so only its placement is flagged.
  if (fromArea === undefined) return undefined;
  if (toArea === undefined) return "target lies outside the areas of src/";
  if (isTestCode(to))
    return "source code may not reference tests or testing helpers";
  if (!ALLOWED[fromArea].includes(toArea))
    return `${fromArea}/ may not reference ${toArea}/`;
  if (from.endsWith(".view.ts")) {
    if (to.endsWith(".boundary.ts") && !PURE_BOUNDARIES.has(to))
      return "a view may not reference an I/O boundary";
    if (!isViewTarget(to))
      return "a view may reference only views, infra/codex/protocol/ and lib/";
  }

  if (
    fromArea === "prwatch" &&
    toArea === "infra" &&
    !to.startsWith("infra/github/")
  )
    return "prwatch/ may reach only infra/github/";
  if (from.startsWith("infra/claude/") && to.startsWith("infra/codex/"))
    return "infra/claude/ may not reference infra/codex/";
  if (
    from.startsWith("conversation/") &&
    !from.startsWith("conversation/claude/") &&
    to.startsWith("conversation/claude/")
  )
    return "conversation/ outside claude/ may not reference conversation/claude/";
  return undefined;
};

const isViewTarget = (path: string) =>
  path.endsWith(".view.ts") ||
  path.startsWith("infra/codex/protocol/") ||
  path.startsWith("lib/");

const areaOf = (path: string) => {
  const [first, ...rest] = path.split("/");
  return first !== undefined && rest.length > 0 && AREAS.has(first)
    ? (first as Area)
    : undefined;
};

const isTestCode = (path: string) =>
  /\.test\.[cm]?tsx?$/.test(path) || path.split("/").includes("testing");

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

      for (const call of requireCalls(source)) {
        references.push({
          kind: "import",
          from: path,
          specifier: call,
          to: undefined,
        });
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

// SourceFile.imports leaves out require() in TypeScript files, which Bun still runs, so every call is reported as unresolvable.
const requireCalls = (source: Node) => {
  const calls: string[] = [];
  const visit = (node: Node): undefined => {
    if (node.kind === SyntaxKind.CallExpression) {
      const callee = (node as Node & { expression: Node }).expression;
      if (
        callee.kind === SyntaxKind.Identifier &&
        "text" in callee &&
        callee.text === "require"
      )
        calls.push(`require(${sourceText(source, node)})`);
    }

    node.forEachChild(visit);
  };

  visit(source);
  return calls;
};

const sourceText = (source: Node, call: Node) => {
  const args = (call as Node & { arguments: readonly Node[] }).arguments;
  const text = "text" in source ? String(source.text) : "";
  return args.map((arg) => text.slice(arg.pos, arg.end).trim()).join(", ");
};

const isPackage = (root: string, target: string) =>
  relative(root, target).split("/").includes("node_modules");

const sourceFiles = async (src: string) => {
  const files: string[] = [];
  for await (const path of new Bun.Glob("**/*.{ts,tsx,mts,cts}").scan({
    cwd: src,
  })) {
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
  from: "link/codex-link.ts",
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
  include: ["**/*.ts", "**/*.tsx"],
});

let tmp: string;
let projects = 0;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "harnexus-deps-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

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
