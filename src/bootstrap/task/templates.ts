import { dirname, join, resolve } from "node:path";
import { Result } from "better-result";
import { z } from "zod";
import {
  isFile,
  readRegularTextFile,
  realPathOrSelf,
} from "../../runtime/fs.boundary.ts";
import { parseJson } from "../../runtime/json.boundary.ts";
import { fail, formatTemplate } from "./format.ts";
import { configHome, type Env, ioFailed } from "./request.ts";

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
    if (!(await isFile(config)))
      return fail(
        `${config} does not exist; set templates.${kind} there to the ${kind} prompt template`,
      );
    const text = yield* Result.await(
      readRegularTextFile(config).then((read) => read.mapError(ioFailed)),
    );
    const raw = parseJson(text);
    if (raw.isErr()) return fail(`${config} is not valid JSON`);
    const parsed = CONFIG.safeParse(raw.value);
    if (!parsed.success)
      return fail(`${config} is invalid: ${z.prettifyError(parsed.error)}`);
    const path = parsed.data.templates[kind];
    if (path === undefined)
      return fail(`templates.${kind} is not set in ${config}`);
    return Result.ok(path);
  });

// A Markdown link target such as the SKILL.md a template names; spaces and parentheses end it.
const LINK_TARGET = /\]\(([^()\s]+)\)/g;

const isRelative = (target: string) =>
  !target.startsWith("/") &&
  !target.startsWith("#") &&
  !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);

const escapeBraces = (text: string) =>
  text.replaceAll("{", "{{").replaceAll("}", "}}");

// Relative targets are resolved before the request's values go in, so no value can add a link that is resolved.
const resolveLinks = (
  template: string,
  path: string,
  fields: Record<string, string>,
) =>
  Result.gen(async function* () {
    let text = "";
    let last = 0;
    for (const match of template.matchAll(LINK_TARGET)) {
      const raw = match[1];
      if (raw === undefined || !isRelative(raw)) continue;
      const target = yield* formatTemplate(raw, fields);
      const hash = target.indexOf("#");
      const file = resolve(
        dirname(path),
        hash === -1 ? target : target.slice(0, hash),
      );
      if (!(await isFile(file)))
        return fail(`${path} links to ${file}, which is not a file`);
      const fragment = hash === -1 ? "" : target.slice(hash);
      text += `${template.slice(last, match.index)}](${escapeBraces(`${await realPathOrSelf(file)}${fragment}`)})`;
      last = match.index + match[0].length;
    }
    return Result.ok(text + template.slice(last));
  });

export const taskPrompt = (
  env: Env,
  kind: TemplateKind,
  fields: Record<string, string>,
) =>
  Result.gen(async function* () {
    const path = yield* Result.await(templatePath(env, kind));
    if (!(await isFile(path)))
      return fail(`the ${kind} template ${path} is not a file`);
    const template = yield* Result.await(
      readRegularTextFile(path).then((read) => read.mapError(ioFailed)),
    );
    const linked = yield* Result.await(resolveLinks(template, path, fields));
    return formatTemplate(linked, fields);
  });
