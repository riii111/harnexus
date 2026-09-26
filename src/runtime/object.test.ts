import { describe, expect, test } from "bun:test";
import { isObject } from "./object.ts";

describe("isObject", () => {
  test.each([
    { name: "a plain object", value: { a: 1 }, expected: true },
    { name: "null", value: null, expected: false },
    { name: "an array", value: [1], expected: false },
    { name: "a string", value: "a", expected: false },
  ])("returns $expected for $name", ({ value, expected }) => {
    expect(isObject(value)).toBe(expected);
  });
});
