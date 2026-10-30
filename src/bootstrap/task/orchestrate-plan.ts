import { createHash } from "node:crypto";
import { Result } from "better-result";
import { isObject } from "../../runtime/object.ts";
import { fail, hasSpace, isBlank } from "./format.ts";
import { readRequest, readText, singleLine } from "./request.ts";

export type Issue = {
  id: string;
  instruction: string;
  dependsOn: string[];
  // The dependency whose branch this one grows from; null without dependencies.
  baseTask: string | null;
  test: string[];
  title: string;
  body: string;
};

export type Plan = {
  planId: string;
  repository: string;
  baseRef: string;
  issues: Issue[];
  // Dependencies before dependents.
  order: string[];
  // Covers the instruction text too, so a plan that means something else never reuses the recorded state.
  fingerprint: string;
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const BRANCH = /^[\p{L}\p{N}_][\p{L}\p{N}_./-]*$/u;
const ISSUE_KEYS = [
  "id",
  "dependsOn",
  "baseTask",
  "test",
  "title",
  "body",
  "instruction",
  "promptFile",
];

const text = (value: unknown, name: string) =>
  typeof value === "string" && !isBlank(value)
    ? Result.ok(value)
    : fail(`${name} must be a nonempty string`);

const issueOf = (raw: unknown, index: number) =>
  Result.gen(async function* () {
    const label = `issues[${index}]`;
    if (!isObject(raw)) return fail(`${label} must be an object`);
    const unknown = Object.keys(raw).filter((key) => !ISSUE_KEYS.includes(key));
    if (unknown.length > 0)
      return fail(`unknown ${label} fields: ${unknown.sort().join(", ")}`);
    const id = String(raw.id);
    if (typeof raw.id !== "string" || !NAME.test(raw.id))
      return fail(`${label}.id must match ${NAME}`);
    const hasInstruction = Object.hasOwn(raw, "instruction");
    const hasFile = Object.hasOwn(raw, "promptFile");
    if (hasInstruction === hasFile)
      return fail(`${id} needs exactly one of instruction and promptFile`);
    let instruction: string;
    if (hasFile) {
      const file = yield* singleLine(raw.promptFile, `${id}.promptFile`);
      if (!file.startsWith("/"))
        return fail(`${id}.promptFile must be an absolute path`);
      instruction = yield* Result.await(readText(file));
    } else if (typeof raw.instruction === "string")
      instruction = raw.instruction;
    else return fail(`${id}.instruction must be a string`);
    yield* text(instruction, `${id} instruction`);
    const dependsOn = raw.dependsOn ?? [];
    if (
      !Array.isArray(dependsOn) ||
      dependsOn.some((dep) => typeof dep !== "string")
    )
      return fail(`${id}.dependsOn must be a list of issue ids`);
    const test = raw.test;
    if (
      !Array.isArray(test) ||
      test.length === 0 ||
      test.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      isBlank(String(test[0]))
    )
      return fail(`${id}.test must be a nonempty argv list of strings`);
    yield* singleLine(raw.title, `${id}.title`);
    yield* text(raw.body, `${id}.body`);
    const baseTask = raw.baseTask ?? null;
    if (baseTask !== null && typeof baseTask !== "string")
      return fail(`${id}.baseTask must be an issue id`);
    return Result.ok<Issue>({
      id,
      instruction,
      dependsOn: dependsOn.map(String),
      baseTask,
      test: test.map(String),
      title: String(raw.title),
      body: String(raw.body),
    });
  });

// Dependencies first; a cycle or unknown id is reported before anything is created.
const ordered = (issues: Issue[]) => {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, trail: string[]): string | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting")
      return `dependency cycle: ${[...trail, id].join(" -> ")}`;
    state.set(id, "visiting");
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const problem = visit(dep, [...trail, id]);
      if (problem !== null) return problem;
    }
    state.set(id, "done");
    order.push(id);
    return null;
  };
  for (const issue of issues) {
    const problem = visit(issue.id, []);
    if (problem !== null) return fail(problem);
  }
  return Result.ok(order);
};

const reach = (byId: Map<string, Issue>, id: string): Set<string> => {
  const seen = new Set<string>();
  const walk = (current: string) => {
    for (const dep of byId.get(current)?.dependsOn ?? [])
      if (!seen.has(dep)) {
        seen.add(dep);
        walk(dep);
      }
  };
  walk(id);
  return seen;
};

export const loadPlan = (path: string) =>
  Result.gen(async function* () {
    const data = yield* Result.await(
      readRequest(path, ["planId", "repository", "baseRef", "issues"], []),
    );
    if (typeof data.planId !== "string" || !NAME.test(data.planId))
      return fail(`planId must match ${NAME}`);
    const repository = yield* singleLine(data.repository, "repository");
    if (!repository.startsWith("/"))
      return fail("repository must be an absolute path");
    const baseRef = yield* singleLine(data.baseRef, "baseRef");
    if (
      hasSpace(baseRef) ||
      !BRANCH.test(baseRef) ||
      baseRef.includes("..") ||
      [".lock", "/", "."].some((end) => baseRef.endsWith(end))
    )
      return fail("baseRef must be a branch name");
    if (!Array.isArray(data.issues) || data.issues.length === 0)
      return fail("issues must be a nonempty list");
    const issues: Issue[] = [];
    for (const [index, raw] of data.issues.entries())
      issues.push(yield* Result.await(issueOf(raw, index)));
    const ids = new Set<string>();
    for (const { id } of issues) {
      if (ids.has(id.toLowerCase()))
        return fail(`issue id ${id} is used twice (ids ignore case)`);
      ids.add(id.toLowerCase());
    }
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    for (const issue of issues) {
      for (const dep of issue.dependsOn) {
        if (!byId.has(dep))
          return fail(`${issue.id} depends on unknown ${dep}`);
        if (dep === issue.id) return fail(`${issue.id} depends on itself`);
      }
      if (new Set(issue.dependsOn).size !== issue.dependsOn.length)
        return fail(`${issue.id}.dependsOn has duplicates`);
    }
    const order = yield* ordered(issues);
    for (const issue of issues) {
      if (issue.dependsOn.length <= 1) {
        if (issue.baseTask !== null && issue.baseTask !== issue.dependsOn[0])
          return fail(`${issue.id}.baseTask must be one of its dependsOn`);
        if (issue.dependsOn.length === 1)
          issue.baseTask = issue.dependsOn[0] ?? null;
        continue;
      }
      if (issue.baseTask === null || !issue.dependsOn.includes(issue.baseTask))
        return fail(
          `${issue.id} has several dependencies, so baseTask must name one of them`,
        );
      const inside = reach(byId, issue.baseTask);
      const missing = issue.dependsOn.filter(
        (dep) => dep !== issue.baseTask && !inside.has(dep),
      );
      if (missing.length > 0)
        return fail(
          `${issue.id}: baseTask ${issue.baseTask} does not build on ${missing.join(", ")}, so their work would be missing`,
        );
    }
    const plan = {
      planId: data.planId,
      repository,
      baseRef,
      issues,
      order,
    };
    return Result.ok<Plan>({
      ...plan,
      fingerprint: createHash("sha256")
        .update(JSON.stringify(plan))
        .digest("hex"),
    });
  });
