import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { withoutSkillBodies, withSkillBodies } from "./skill-prompt.ts";

describe("withSkillBodies", () => {
  test("adds each linked SKILL.md after the prompt in the shape Codex uses", () => {
    const typed =
      "[$one](/skills/one/SKILL.md) and [$two](/skills/two/SKILL.md) go";

    const prompt = withSkillBodies(typed, readFrom(FILES));

    expect(prompt).toEqual({
      text: `${typed}\n\n<skill>\n<name>one</name>\n<path>/skills/one/SKILL.md</path>\nFirst.\n</skill>\n\n<skill>\n<name>two</name>\n<path>/skills/two/SKILL.md</path>\nSecond.\n</skill>`,
      unreadable: [],
    });
  });

  test("adds a skill linked twice once", () => {
    const typed = "[$one](/skills/one/SKILL.md) [$one](/skills/one/SKILL.md)";

    const prompt = withSkillBodies(typed, readFrom(FILES));

    expect(prompt.text.split("<skill>")).toHaveLength(2);
  });

  test("leaves the link alone and reports it when its file cannot be read", () => {
    const typed = "[$gone](/skills/gone/SKILL.md) go";

    const prompt = withSkillBodies(typed, readFrom(FILES));

    expect(prompt).toEqual({
      text: typed,
      unreadable: ["/skills/gone/SKILL.md"],
    });
  });

  test.each([
    { name: "a link to another file", typed: "[$one](/skills/one/README.md)" },
    { name: "a relative path", typed: "[$one](skills/one/SKILL.md)" },
    {
      name: "a link without the skill sign",
      typed: "[one](/skills/one/SKILL.md)",
    },
  ])("reads nothing for $name", ({ typed }) => {
    const read: string[] = [];

    const prompt = withSkillBodies(typed, (path) => {
      read.push(path);
      return Result.ok("");
    });

    expect({ prompt, read }).toEqual({
      prompt: { text: typed, unreadable: [] },
      read: [],
    });
  });
});

describe("withoutSkillBodies", () => {
  test.each([
    {
      name: "with the added skill files",
      typed: "[$one](/skills/one/SKILL.md) and [$two](/skills/two/SKILL.md) go",
    },
    {
      name: "whose file could not be read",
      typed: "[$gone](/skills/gone/SKILL.md) go",
    },
    { name: "without skill links", typed: "plain <skill> text" },
  ])("returns the prompt as typed for a prompt $name", ({ typed }) => {
    const sent = withSkillBodies(typed, readFrom(FILES)).text;

    expect(withoutSkillBodies(sent)).toBe(typed);
  });
});

const FILES: Record<string, string> = {
  "/skills/one/SKILL.md": "First.\n",
  "/skills/two/SKILL.md": "Second.",
};

const readFrom = (files: Record<string, string>) => (path: string) => {
  const body = files[path];
  return body === undefined
    ? Result.err(new Error("missing"))
    : Result.ok(body);
};
