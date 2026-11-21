import { describe, expect, test } from "bun:test";

import { foreignVariables, ownedVariables, ownsAgent } from "./launchd-plan.ts";

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

describe("ownsAgent", () => {
  test.each([
    { name: "no file", agent: null, expected: false },
    {
      name: "a file with another label",
      agent: "<key>Label</key><string>com.example.environment</string>",
      expected: false,
    },
    {
      name: "the label an earlier harnexus wrote",
      agent:
        "<dict>\n<key>Label</key><string>com.harnexus.environment</string>\n</dict>",
      expected: true,
    },
  ])("tells $name as $expected", ({ agent, expected }) => {
    expect(ownsAgent(agent)).toBe(expected);
  });
});
