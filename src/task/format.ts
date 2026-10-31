import { Result, TaggedError } from "better-result";
import { isObject } from "../runtime/object.ts";

export class TaskFailed extends TaggedError("TaskFailed")<{
  message: string;
}> {}

export const fail = (message: string) =>
  Result.err(new TaskFailed({ message }));

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

// A child's output is repeated in an error only as far as it names the cause.
export const detail = (text: string) => text.trim().slice(0, 500);

// Named fields only, and an unknown field or stray brace is an error, so a changed template never sends a half-filled prompt.
// refuse names what is wrong with a value at that place, or returns null to accept it.
export const formatTemplate = (
  template: string,
  fields: Record<string, string>,
  refuse: (value: string) => string | null = () => null,
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
      else {
        const refused = refuse(value);
        if (refused !== null) problem ??= `{${name}} ${refused}`;
      }
      return value ?? match;
    },
  );
  return problem === null ? Result.ok(text) : fail(problem);
};
