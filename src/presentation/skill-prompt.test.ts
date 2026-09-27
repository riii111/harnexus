import { describe, expect, test } from "bun:test";
import { skillBlock, skillLinks } from "./skill-prompt.ts";

describe("skillLinks", () => {
  test("finds each linked SKILL.md once in the order it appears", () => {
    const links = skillLinks(
      "[$one](/skills/one/SKILL.md) [$two](/skills/two/SKILL.md) [$one](/skills/one/SKILL.md)",
    );

    expect(links).toEqual([
      { name: "one", path: "/skills/one/SKILL.md" },
      { name: "two", path: "/skills/two/SKILL.md" },
    ]);
  });

  test.each([
    { name: "a link to another file", typed: "[$one](/skills/one/README.md)" },
    { name: "a relative path", typed: "[$one](skills/one/SKILL.md)" },
    {
      name: "a link without the skill sign",
      typed: "[one](/skills/one/SKILL.md)",
    },
  ])("finds nothing in $name", ({ typed }) => {
    expect(skillLinks(typed)).toEqual([]);
  });
});

describe("skillBlock", () => {
  test.each([
    { name: "with", body: "Do it.\n" },
    { name: "without", body: "Do it." },
  ])("wraps a file $name a final newline in the shape Codex uses", ({
    body,
  }) => {
    expect(skillBlock("one", "/skills/one/SKILL.md", body)).toBe(
      "<skill>\n<name>one</name>\n<path>/skills/one/SKILL.md</path>\nDo it.\n</skill>",
    );
  });
});
