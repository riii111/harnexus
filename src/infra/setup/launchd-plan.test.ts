import { describe, expect, test } from "bun:test";

import { ownsAgent } from "./launchd-plan.ts";

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
