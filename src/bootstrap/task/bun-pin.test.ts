import { describe, expect, test } from "bun:test";
import { unpinnedBun } from "./bun-pin.ts";

describe("unpinnedBun", () => {
  test("accepts the pinned Bun", () => {
    expect(unpinnedBun("1.4.4", "1.4.4")).toBeNull();
  });

  test.each([
    {
      name: "an older Bun",
      pinned: "1.4.4",
      running: "1.3.5",
      expected:
        "Bun 1.3.5 runs this build, while harnexus pins 1.4.4; install Bun 1.4.4 and run bun run install:task again",
    },
    {
      name: "a manifest without a pin",
      pinned: null,
      running: "1.4.4",
      expected:
        "Bun 1.4.4 runs this build, while package.json pins no Bun version",
    },
  ])("refuses $name", ({ pinned, running, expected }) => {
    expect(unpinnedBun(pinned, running)).toBe(expected);
  });
});
