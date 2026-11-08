import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// Harnexus ships only the connection between Claude and the Codex App; task runners, PR watchers, personal skills and review output belong to outside tools, which reach it through the call socket or a registered adapter.
// The dependency rules keep src/ to its own areas and declared packages, so the graph is checked here by the packages and the shipped files.
const ROOT = join(import.meta.dir, "..");
const SELF = relative(ROOT, import.meta.path);

// Outside tools the product must not depend on, import, fetch or name.
const OUTSIDE_TOOLS = ["harnexus-crew", "pr-wake"];

// The personal workflow and its parsed review output, by the names they were shipped under.
const PERSONAL_WORKFLOW = [
  "task-worker",
  "task-review-cycle",
  "task-session-launch",
  "task-orchestration",
  "ai-code-review",
  "pr-watch-link",
  "/cloud-review",
  "reviewsIn",
  "CloudReview",
];

const REMOVED_PATHS = [
  "src/features/task/",
  "src/features/prwatch/",
  "src/infra/github/",
  "src/features/conversation/claude/cloud/reviews.ts",
  "src/features/conversation/claude/cloud/review-chats.ts",
  "test/fixtures/task-skills/",
  "scripts/install-cloud-task.sh",
];

const shippedFiles = () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  expect(listed.exitCode).toBe(0);
  return listed.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "" && path !== SELF);
};

describe("product scope", () => {
  test("declares no outside tool as a package", async () => {
    const manifest = JSON.parse(
      await readFile(join(ROOT, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const declared = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ].flatMap((field) => Object.keys(manifest[field] ?? {}));

    expect(declared.filter((name) => OUTSIDE_TOOLS.includes(name))).toEqual([]);
  });

  test("ships none of the files moved to outside tools", () => {
    const files = shippedFiles();

    expect(
      files.filter((path) => REMOVED_PATHS.some((p) => path.startsWith(p))),
    ).toEqual([]);
  });

  test("names no outside tool or personal workflow in any shipped file", async () => {
    const found: string[] = [];
    for (const path of shippedFiles()) {
      const text = await readFile(join(ROOT, path), "utf8");
      for (const term of [...OUTSIDE_TOOLS, ...PERSONAL_WORKFLOW]) {
        if (text.includes(term)) found.push(`${path}: ${term}`);
      }
    }

    expect(found).toEqual([]);
  });
});
