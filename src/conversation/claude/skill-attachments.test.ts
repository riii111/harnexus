import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkills } from "./skill-attachments.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-skills-"));
  await mkdir(join(dir, "one"));
  await writeFile(join(dir, "one", "SKILL.md"), "Do it.\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readSkills", () => {
  test("reads each readable SKILL.md into a block and reports the ones it cannot read", async () => {
    const one = join(dir, "one", "SKILL.md");
    const gone = join(dir, "gone", "SKILL.md");

    const skills = await readSkills(`[$one](${one}) [$gone](${gone})`);

    expect(skills).toEqual({
      skills: [
        {
          path: one,
          body: "Do it.\n",
          block: `<skill>\n<name>one</name>\n<path>${one}</path>\nDo it.\n</skill>`,
        },
      ],
      unreadable: [gone],
    });
  });
});
