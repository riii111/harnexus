import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillAttachments } from "./skill-attachments.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-skills-"));
  await mkdir(join(dir, "one"));
  await writeFile(join(dir, "one", "SKILL.md"), "Do it.\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("skillAttachments", () => {
  test("attaches each readable SKILL.md and reports the ones it cannot read", async () => {
    const one = join(dir, "one", "SKILL.md");
    const gone = join(dir, "gone", "SKILL.md");

    const skills = await skillAttachments(`[$one](${one}) [$gone](${gone})`);

    expect(skills).toEqual({
      attachments: [
        `<skill>\n<name>one</name>\n<path>${one}</path>\nDo it.\n</skill>`,
      ],
      unreadable: [gone],
    });
  });

  test("attaches nothing to a prompt without skill links", async () => {
    expect(await skillAttachments("plain")).toEqual({
      attachments: [],
      unreadable: [],
    });
  });
});
