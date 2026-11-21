import { describe, expect, test } from "bun:test";

import {
  foreignVariables,
  isAppRunning,
  openArguments,
  openEnvironment,
  ownedVariables,
} from "./open-app-plan.ts";

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

  test("passes this shell's paths, version policy, permission mode and call socket without credentials", () => {
    const args = openArguments(PATHS, "harnexus", {
      HARNEXUS_LOG_PATH: "/tmp/harnexus.log",
      HARNEXUS_STATE_PATH: "",
      HARNEXUS_UNVERIFIED_CODEX: "pause",
      HARNEXUS_PERMISSION_MODE: "auto",
      HARNEXUS_CALL_SOCKET: "off",
      ANTHROPIC_API_KEY: "sk-fixture",
    });

    expect(args.slice(-8)).toEqual([
      "--env",
      "HARNEXUS_LOG_PATH=/tmp/harnexus.log",
      "--env",
      "HARNEXUS_UNVERIFIED_CODEX=pause",
      "--env",
      "HARNEXUS_PERMISSION_MODE=auto",
      "--env",
      "HARNEXUS_CALL_SOCKET=off",
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

describe("ownedVariables", () => {
  test("takes every harnexus variable and a Codex CLI path naming this launcher even after the checkout is gone", () => {
    expect(
      ownedVariables({
        CODEX_CLI_PATH: "/deleted/harnexus/bin/harnexus-codex",
        HARNEXUS_CODEX_PATH: "/codex",
        HARNEXUS_CALL_SOCKET: "on",
      }),
    ).toEqual([
      "CODEX_CLI_PATH",
      "HARNEXUS_CODEX_PATH",
      "HARNEXUS_CALL_SOCKET",
    ]);
  });

  test("leaves a Codex CLI path another tool registered to it", () => {
    const env = {
      CODEX_CLI_PATH: "/opt/other/bin/codex-wrapper",
      HARNEXUS_BUN_PATH: "/bun",
    };

    expect({
      owned: ownedVariables(env),
      foreign: foreignVariables(env),
    }).toEqual({ owned: ["HARNEXUS_BUN_PATH"], foreign: ["CODEX_CLI_PATH"] });
  });
});

describe("openEnvironment", () => {
  test("hands a standard launch none of the harnexus setup of the calling shell but keeps another tool's Codex CLI path", () => {
    const env = openEnvironment("standard", {
      PATH: "/usr/bin",
      CODEX_CLI_PATH: "/work/harnexus/bin/harnexus-codex",
      HARNEXUS_CODEX_PATH: "/codex",
      HARNEXUS_BUN_PATH: "/bun",
    });
    const other = openEnvironment("standard", {
      CODEX_CLI_PATH: "/opt/other/bin/codex-wrapper",
    });

    expect({ env, other }).toEqual({
      env: { PATH: "/usr/bin" },
      other: { CODEX_CLI_PATH: "/opt/other/bin/codex-wrapper" },
    });
  });

  test("keeps the calling shell's environment for a harnexus launch", () => {
    const shell = { PATH: "/usr/bin", HARNEXUS_LOG_PATH: "/tmp/h.log" };

    expect(openEnvironment("harnexus", shell)).toEqual(shell);
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
      name: "a helper left under Contents/Frameworks",
      command:
        "/Applications/ChatGPT.app/Contents/Frameworks/Codex Helper (Renderer).app/Contents/MacOS/Codex Helper (Renderer)",
      expected: false,
    },
    {
      name: "the bundled Codex CLI",
      command:
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server",
      expected: false,
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
