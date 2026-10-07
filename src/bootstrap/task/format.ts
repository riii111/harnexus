import { Result, TaggedError } from "better-result";
import { isObject } from "../../runtime/object.ts";

export class TaskFailed extends TaggedError("TaskFailed")<{
  message: string;
}> {}

export const fail = (message: string) =>
  Result.err(new TaskFailed({ message }));

export type Fields = Record<string, unknown>;

// Python's str.isspace() set, so requests the Python taskctl accepted are accepted alike.
export const SPACE_CHARS =
  "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACE = new RegExp(`[${SPACE_CHARS}]`, "u");

export const hasSpace = (value: string) => SPACE.test(value);

export const isBlank = (value: string) =>
  [...value].every((char) => SPACE.test(char));

// Python truthiness, which decides whether state recorded by either version counts as present.
export const truthy = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== false &&
  value !== 0 &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0) &&
  !(isObject(value) && Object.keys(value).length === 0);

export const jsonEqual = (a: unknown, b: unknown) => Bun.deepEquals(a, b, true);

export const asText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null);

// Named fields only, and an unknown field or stray brace is an error, so a changed template never sends a half-filled prompt.
export const formatTemplate = (
  template: string,
  fields: Record<string, string>,
): Result<string, TaskFailed> => {
  let problem: string | null = null;
  const text = template.replace(
    /\{\{|\}\}|\{([^{}]*)\}|[{}]/g,
    (match, name: string | undefined) => {
      if (match === "{{") return "{";
      if (match === "}}") return "}";
      if (name === undefined) {
        problem ??= `single '${match}' in template`;
        return match;
      }
      const value = Object.hasOwn(fields, name) ? fields[name] : undefined;
      if (value === undefined) problem ??= `unknown template field {${name}}`;
      return value ?? match;
    },
  );
  return problem === null ? Result.ok(text) : fail(problem);
};
