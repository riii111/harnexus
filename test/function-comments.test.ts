import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  computeLineStarts,
  getLeadingCommentRanges,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";

const ROOT = join(import.meta.dir, "..");

describe("comments above short functions in src", () => {
  test("appear only on the listed functions", async () => {
    const found = await findCommentedShortFunctions(ROOT);

    const names = found.map((item) => item.id);

    expect(names.filter((id) => !EXISTING.includes(id))).toEqual([]);
    expect(EXISTING.filter((id) => !names.includes(id))).toEqual([]);
  });
});

describe("findCommentedShortFunctions", () => {
  test("reports a line comment above a function of up to the short length", async () => {
    const root = await writeProject({
      "a.ts": `// Explains the name.
export const one = (x: number) => x + 1;

// Explains the name too.
export function two(x: number) { return x; }

// Explains a name over the short length.
export const three = (x: number) => {
  const y = x;
  return y;
};

const holder = () => {
  // Explains the name inside a closure.
  const inner = () => 1;
  return inner;
};
export { holder };`,
    });

    const found = await findCommentedShortFunctions(root);

    expect(found.map((item) => item.id)).toEqual([
      "a.ts#one",
      "a.ts#two",
      "a.ts#inner",
    ]);
  });

  test("leaves long functions, other comment forms and unrelated statements alone", async () => {
    const root = await writeProject({
      "b.ts": `// Explains a function longer than the short length.
export const long = (x: number) => {
  const a = x + 1;
  const b = a + 1;
  return b;
};

/** Documents a short function. */
export const documented = () => 1;

// TODO: decide when the second caller exists.
export const todo = () => 1;

// biome-ignore lint/suspicious/noExplicitAny: fixture
export const ignored = (x: any) => x;

// Explains a constant, not a function.
export const LIMIT = 4;

export const bare = () => 1;`,
    });

    const found = await findCommentedShortFunctions(root);

    expect(found).toEqual([]);
  });
});

type Found = { id: string };

// The short length is the lines a declaration takes once Biome has wrapped it, so a function of one expression or a few statements counts.
const SHORT_LINES = 2;

// A comment above a short function mostly says what its name could, or a reason that applies to one line of it; the reason belongs on that line.
// The functions below were written before this check; move the comment to the line it explains, or into a name, and delete the entry. An entry that no longer matches fails the test.
const EXISTING: string[] = [
  "bootstrap/doctor-report.ts#runs",
  "bootstrap/feedback-protocol.ts#variantOf",
  "bootstrap/setup-facts.ts#codexVersionOf",
  "conversation/claude/cloud.ts#copyOf",
  "conversation/controller.ts#reject",
  "conversation/side-chat.ts#runsOnClaude",
  "conversation/thread-request.ts#isSameDirectory",
  "conversation/thread-values.ts#forkPinOf",
  "conversation/thread-values.ts#consumePick",
  "infra/claude/auth.ts#headerLines",
  "infra/claude/models.ts#isClaudeModel",
  "infra/codex/delegations.ts#differs",
  "infra/codex/shape.ts#isShapePath",
  "infra/thread-store.ts#encodeMarkerName",
  "presentation/history-page.ts#itemAnchorCursor",
  "presentation/history-page.ts#pageSize",
  "presentation/history.ts#isMetaMessage",
  "presentation/permission.ts#choicesFor",
  "presentation/tools.ts#declineToolItem",
  "presentation/turn.ts#steeredTurn",
  "presentation/turn.ts#nextItemId",
  "prwatch/classify.ts#isApproval",
  "prwatch/events.ts#reviewKey",
  "prwatch/message.ts#headerOf",
  "prwatch/store.ts#recordLink",
  "prwatch/store.ts#botKey",
  "prwatch/store.ts#recordSender",
  "task/cli.ts#withoutName",
  "task/cloud-review.ts#directory",
  "task/format.ts#detail",
  "task/request.ts#absoluteOr",
  "task/templates.ts#templateConfigPath",
  "task/watch-worker.ts#isPromptOf",
];

const findCommentedShortFunctions = async (root: string) => {
  const src = join(root, "src");
  const api = new API({ cwd: root });
  try {
    const snapshot = await api.updateSnapshot({
      openProject: join(root, "tsconfig.json"),
    });
    const project = snapshot.getProjects()[0];
    if (project === undefined) throw new Error("tsconfig.json has no project");
    const found: Found[] = [];
    for (const file of await sourceFiles(src)) {
      const source = await project.program.getSourceFile(file);
      if (source === undefined)
        throw new Error(`${file} is not in the project`);
      const text = String((source as Node & { text: string }).text);
      const lineStarts = computeLineStarts(text);
      const lineOf = (offset: number) => lineIndex(lineStarts, offset);
      const visit = (node: Node): undefined => {
        const name = functionNameOf(node);
        if (name !== undefined && hasLeadingLineComment(text, node.pos)) {
          const start = startOf(text, node);
          if (lineOf(node.end) - lineOf(start) + 1 <= SHORT_LINES) {
            found.push({ id: `${relative(src, file)}#${name}` });
          }
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
    return found;
  } finally {
    await api.close();
  }
};

const functionNameOf = (node: Node): string | undefined => {
  if (node.kind === SyntaxKind.FunctionDeclaration) {
    return (node as Node & { name?: { text: string } }).name?.text;
  }
  if (node.kind !== SyntaxKind.VariableStatement) return undefined;
  const { declarations } = (
    node as Node & {
      declarationList: {
        declarations: readonly (Node & {
          name: { text?: string };
          initializer?: Node;
        })[];
      };
    }
  ).declarationList;
  const [declaration] = declarations;
  if (declarations.length !== 1 || declaration === undefined) return undefined;
  const kind = declaration.initializer?.kind;
  return kind === SyntaxKind.ArrowFunction ||
    kind === SyntaxKind.FunctionExpression
    ? declaration.name.text
    : undefined;
};

// Only the line comments that explain; a directive, a TODO or a documentation comment is not one.
const hasLeadingLineComment = (text: string, pos: number) =>
  (getLeadingCommentRanges(text, pos) ?? []).some(
    (range) =>
      range.kind === SyntaxKind.SingleLineCommentTrivia &&
      !DIRECTIVE.test(text.slice(range.pos, range.end)),
  );

const DIRECTIVE = /^\/\/\s*(TODO|biome-ignore|@ts-)/;

const startOf = (text: string, node: Node) => {
  const comments = getLeadingCommentRanges(text, node.pos) ?? [];
  let offset = comments.at(-1)?.end ?? node.pos;
  while (/\s/.test(text[offset] ?? "")) offset += 1;
  return offset;
};

const lineIndex = (lineStarts: readonly number[], offset: number) => {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
};

const sourceFiles = async (src: string) => {
  const files: string[] = [];
  for await (const path of new Bun.Glob("**/*.{ts,tsx,mts,cts}").scan({
    cwd: src,
  })) {
    if (!isTestCode(path)) files.push(join(src, path));
  }
  return files.sort();
};

const isTestCode = (path: string) =>
  /\.test\.[cm]?tsx?$/.test(path) || path.split("/").includes("testing");

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
  tmp = await mkdtemp(join(tmpdir(), "harnexus-comments-"));
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
