import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connectionSettingsPath,
  loadConnectionSettings,
} from "./connection-settings.boundary.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-settings-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (text: string) => {
  await mkdir(join(dir, "harnexus"), { recursive: true });
  await writeFile(join(dir, "harnexus", "connection.json"), text);
};

describe("loadConnectionSettings", () => {
  test("sets no /cloud skill when the file is missing", async () => {
    const loaded = await loadConnectionSettings({ XDG_CONFIG_HOME: dir });

    expect(loaded.unwrap()).toEqual({
      cloudSkills: [],
      externalConversationAdapter: null,
    });
  });

  test("reads the skills set to mean /cloud", async () => {
    await write(JSON.stringify({ cloudSkills: ["cloud-session"] }));

    const loaded = await loadConnectionSettings({ XDG_CONFIG_HOME: dir });

    expect(loaded.unwrap()).toEqual({
      cloudSkills: ["cloud-session"],
      externalConversationAdapter: null,
    });
  });

  test("reads the outside conversation adapter the user registered", async () => {
    await write(
      JSON.stringify({
        externalConversationAdapter: {
          id: "taskctl",
          command: "/opt/taskctl/bin/adapter",
          mode: "observe",
        },
      }),
    );

    const loaded = await loadConnectionSettings({ XDG_CONFIG_HOME: dir });

    expect(loaded.unwrap().externalConversationAdapter).toEqual({
      id: "taskctl",
      command: "/opt/taskctl/bin/adapter",
      args: [],
      mode: "observe",
    });
  });

  test.each([
    { name: "a file that is not JSON", text: "{" },
    {
      name: "a list that is not of skill names",
      text: '{"cloudSkills":["a b"]}',
    },
    {
      name: "a list that is not a list",
      text: '{"cloudSkills":"cloud-session"}',
    },
    {
      name: "an adapter named by a relative command",
      text: '{"externalConversationAdapter":{"id":"a","command":"bin/a","mode":"write"}}',
    },
    {
      name: "an adapter with an unknown mode",
      text: '{"externalConversationAdapter":{"id":"a","command":"/bin/a","mode":"all"}}',
    },
  ])("refuses $name", async ({ text }) => {
    await write(text);

    const loaded = await loadConnectionSettings({ XDG_CONFIG_HOME: dir });

    expect(loaded.isErr()).toBe(true);
  });
});

describe("connectionSettingsPath", () => {
  test("ignores a relative XDG_CONFIG_HOME", () => {
    expect(
      connectionSettingsPath({ XDG_CONFIG_HOME: "rel" }, () => "/home/u"),
    ).toBe("/home/u/.config/harnexus/connection.json");
  });
});
