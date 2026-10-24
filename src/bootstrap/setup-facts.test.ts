import { describe, expect, test } from "bun:test";
import { codexVersionOf } from "./setup-facts.ts";

describe("codexVersionOf", () => {
  test.each([
    {
      name: "the CLI's version line",
      output: "codex-cli 0.163.0-alpha.10.2\n",
      expected: "0.163.0-alpha.10.2",
    },
    { name: "text without a version", output: "codex\n", expected: null },
    {
      name: "a version followed by other text",
      output: "codex-cli 0.163.0;rm -rf ~",
      expected: null,
    },
  ])("reads $name", ({ output, expected }) => {
    expect(codexVersionOf(output)).toBe(expected);
  });
});
