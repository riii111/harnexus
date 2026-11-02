import { describe, expect, test } from "bun:test";
import { compileRegex } from "./regex.boundary.ts";

describe("compileRegex", () => {
  test("compiles a valid source into a regular expression", () => {
    const compiled = compileRegex("^v[0-9]+$");

    expect(compiled.isOk() && compiled.value.test("v12")).toBe(true);
  });

  test("keeps the engine's error as the cause of an invalid source", () => {
    const compiled = compileRegex("(unclosed");

    expect(compiled.isErr() && compiled.error._tag).toBe("RegexInvalid");
    expect(compiled.isErr() && compiled.error.cause).toBeInstanceOf(
      SyntaxError,
    );
  });
});
