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

// Python truthiness, which decides whether recorded state counts as present.
export const truthy = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== false &&
  value !== 0 &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0) &&
  !(isObject(value) && Object.keys(value).length === 0);

export const jsonEqual = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
    );
  }
  return a === b;
};

// json.dumps with its default separators, so stdout reads exactly as the Python taskctl printed it.
export const pyDumps = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(pyDumps).join(", ")}]`;
  if (isObject(value))
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pyDumps(item)}`)
      .join(", ")}}`;
  return JSON.stringify(value ?? null);
};

// str() of a JSON value as Python formats it into a message.
export const pyStr = (value: unknown) =>
  typeof value === "string" ? value : pyRepr(value);

const pyRepr = (value: unknown): string => {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return reprString(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isObject(value))
    return `{${Object.entries(value)
      .map(([key, item]) => `${reprString(key)}: ${pyRepr(item)}`)
      .join(", ")}}`;
  return String(value);
};

const reprString = (value: string) => {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = [...value].map((char) => {
    if (char === "\\" || char === quote) return `\\${char}`;
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0xa0)
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : char;
  });
  return `${quote}${escaped.join("")}${quote}`;
};

// str.format with named fields only, which is all the installed templates use.
export const pyFormat = (
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
        problem ??= `Single '${match}' encountered in format string`;
        return match;
      }
      const value = Object.hasOwn(fields, name) ? fields[name] : undefined;
      if (value === undefined) problem ??= `unknown template field {${name}}`;
      return value ?? match;
    },
  );
  return problem === null ? Result.ok(text) : fail(problem);
};
