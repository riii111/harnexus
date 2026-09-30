import { describe, expect, test } from "bun:test";
import { isAppRunning, openArguments } from "./open-app-plan.ts";

describe("openArguments", () => {
  test("opens the app with the launcher as its Codex CLI and the paths the launcher needs", () => {
    const args = openArguments(PATHS, "harnexus", {});

    expect(args).toEqual([
      "-a",
      "/Applications/ChatGPT.app",
      "--env",
      "CODEX_CLI_PATH=/work/harnexus/bin/harnexus-codex",
      "--env",
      "HARNEXUS_CODEX_PATH=/Applications/ChatGPT.app/codex",
      "--env",
      "HARNEXUS_BUN_PATH=/usr/local/bin/bun",
    ]);
  });

  test("passes this shell's log, state and version settings through and leaves others out", () => {
    const args = openArguments(PATHS, "harnexus", {
      HARNEXUS_LOG_PATH: "/tmp/harnexus.log",
      HARNEXUS_STATE_PATH: "",
      HARNEXUS_UNVERIFIED_CODEX: "pause",
      ANTHROPIC_API_KEY: "sk-fixture",
    });

    expect(args.slice(-4)).toEqual([
      "--env",
      "HARNEXUS_LOG_PATH=/tmp/harnexus.log",
      "--env",
      "HARNEXUS_UNVERIFIED_CODEX=pause",
    ]);
    expect(args.join(" ")).not.toContain("sk-fixture");
  });

  test("opens the app as it normally runs in standard mode", () => {
    const args = openArguments(PATHS, "standard", {
      HARNEXUS_LOG_PATH: "/tmp/harnexus.log",
    });

    expect(args).toEqual(["-a", "/Applications/ChatGPT.app"]);
  });
});

describe("isAppRunning", () => {
  test.each([
    {
      name: "the app's own binary",
      command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      expected: true,
    },
    {
      name: "a process that only names the app",
      command: "/bin/zsh -c open /Applications/ChatGPT.app/Contents/MacOS/x",
      expected: false,
    },
  ])("tells the app runs from $name as $expected", ({ command, expected }) => {
    expect(
      isAppRunning([{ pid: 1, ppid: 1, command }], "/Applications/ChatGPT.app"),
    ).toBe(expected);
  });
});

const PATHS = {
  app: "/Applications/ChatGPT.app",
  launcher: "/work/harnexus/bin/harnexus-codex",
  codex: "/Applications/ChatGPT.app/codex",
  bun: "/usr/local/bin/bun",
};
