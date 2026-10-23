import { dirname, join, resolve } from "node:path";
import { Result } from "better-result";
import { z } from "zod";
import {
  isFile,
  pathExists,
  realPathOrSelf,
} from "../../runtime/fs.boundary.ts";
import { fail, formatTemplate, TaskFailed } from "./format.ts";
import { configHome, type Env, readJson, readText } from "./request.ts";

export type TemplateKind = "worker" | "reviewer";

// Beside harnexus's other config, never in the repository or the working directory, so a sandboxed agent cannot pick the prompt a new chat receives.
export const templateConfigPath = (env: Env) =>
  join(configHome(env), "task.json");

const TEMPLATE_PATH = z
  .string()
  .refine((path) => path.startsWith("/"), { message: "must be absolute" });

const CONFIG = z.strictObject({
  templates: z.strictObject({
    worker: TEMPLATE_PATH.optional(),
    reviewer: TEMPLATE_PATH.optional(),
  }),
});

const templatePath = (env: Env, kind: TemplateKind) =>
  Result.gen(async function* () {
    const config = templateConfigPath(env);
    if (!(await pathExists(config)))
      return fail(
        `${config} does not exist; set templates.${kind} there to the ${kind} prompt template`,
      );
    const parsed = CONFIG.safeParse(yield* Result.await(readJson(config)));
    if (!parsed.success)
      return fail(`${config} is invalid: ${z.prettifyError(parsed.error)}`);
    const path = parsed.data.templates[kind];
    if (path === undefined)
      return fail(`templates.${kind} is not set in ${config}`);
    return Result.ok(path);
  });

// An inline Markdown link target such as the SKILL.md a template names, up to the first closing parenthesis on its line; a line opening with [label]: may be prose, so reference definitions are left as written.
const LINK_TARGET = /\]\(([^)\n]*)\)/dg;

const targets = (template: string) =>
  [...template.matchAll(LINK_TARGET)].flatMap((match) => {
    const span = match.indices?.[1];
    return span === undefined
      ? []
      : [{ raw: match[1] ?? "", start: span[0], end: span[1] }];
  });

// A code span: a backtick run, not escaped, closed by a run of the same length before any blank line.
const SPAN =
  /(?<![`\\])(`+)(?!`)(?:(?!\r?\n[ \t]*\r?\n)[\s\S])*?(?<!`)\1(?!`)/g;

// Fenced code blocks and code spans, whose link-like text is an example to show rather than a link.
const codeRanges = (template: string) => {
  const ranges: [number, number][] = [];
  let open: { fence: string; start: number } | null = null;
  for (const line of template.matchAll(/^ {0,3}(`{3,}|~{3,})(.*)$/gm)) {
    const fence = line[1] ?? "";
    const rest = line[2] ?? "";
    if (open === null) {
      if (!(fence.startsWith("`") && rest.includes("`")))
        open = { fence, start: line.index };
    } else if (
      fence[0] === open.fence[0] &&
      fence.length >= open.fence.length &&
      rest.trim() === ""
    ) {
      ranges.push([open.start, line.index + line[0].length]);
      open = null;
    }
  }
  if (open !== null) ranges.push([open.start, template.length]);
  // Blanking the blocks keeps their backticks from pairing with a span outside.
  let outside = template;
  for (const [start, end] of ranges)
    outside =
      outside.slice(0, start) + " ".repeat(end - start) + outside.slice(end);
  for (const span of outside.matchAll(SPAN))
    ranges.push([span.index, span.index + span[0].length]);
  return ranges;
};

// A value inside a target is a name, never a path, so none can lead the link to another folder or break it.
const targetValue = (value: string) =>
  /^[\p{L}\p{N}_-]+$/u.test(value)
    ? null
    : "may hold only letters, digits, _ and - inside a link target";

// A target opening with a field is the value's to decide, as with {pr_url} or {checkout}.
const isRelative = (path: string) =>
  path !== "" &&
  !path.startsWith("/") &&
  !(path.startsWith("{") && !path.startsWith("{{")) &&
  !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path);

const escapeBraces = (text: string) =>
  text.replaceAll("{", "{{").replaceAll("}", "}}");

// Links are found before the request's values go into the text, so no value can add one.
const resolveLinks = (
  template: string,
  path: string,
  fields: Record<string, string>,
) =>
  Result.gen(async function* () {
    // The layout is the one the templates were written in, so a symlinked template resolves beside its real file.
    const folder = dirname(await realPathOrSelf(path));
    const code = codeRanges(template);
    let text = "";
    let last = 0;
    for (const { raw, start, end } of targets(template)) {
      if (code.some(([from, to]) => start >= from && start < to)) continue;
      const hash = raw.indexOf("#");
      const rawPath = hash === -1 ? raw : raw.slice(0, hash);
      if (!isRelative(rawPath.replace(/^</, "").trimStart())) continue;
      // The app attaches a skill only from a bare target, so a relative one with angle brackets, a space or a title would reach the chat unresolved.
      if (/^<|\s/.test(raw))
        return fail(
          `links to "${raw}"; write a relative target without angle brackets, spaces or a title`,
        );
      const file = resolve(
        folder,
        yield* formatTemplate(rawPath, fields, targetValue),
      );
      if (!(await isFile(file)))
        return fail(`links to ${file}, which is not a file`);
      const real = await realPathOrSelf(file);
      // A link target ends at a space or parenthesis, and Markdown reads a # as an anchor and a backslash as an escape.
      if (/[\s()#\\]/.test(real))
        return fail(
          `links to ${real}, whose path has a space, parenthesis, # or backslash`,
        );
      const fragment =
        hash === -1
          ? ""
          : yield* formatTemplate(raw.slice(hash), fields, targetValue);
      text += template.slice(last, start) + escapeBraces(real + fragment);
      last = end;
    }
    return Result.ok(text + template.slice(last));
  });

const render = (path: string, fields: Record<string, string>) =>
  Result.gen(async function* () {
    const template = yield* Result.await(readText(path));
    const linked = yield* Result.await(resolveLinks(template, path, fields));
    return formatTemplate(linked, fields);
  });

export const taskPrompt = (
  env: Env,
  kind: TemplateKind,
  fields: Record<string, string>,
) =>
  Result.gen(async function* () {
    const path = yield* Result.await(templatePath(env, kind));
    const prompt = await render(path, fields);
    return prompt.mapError(
      (error) =>
        new TaskFailed({
          message: `the ${kind} template ${path}: ${error.message}`,
        }),
    );
  });
