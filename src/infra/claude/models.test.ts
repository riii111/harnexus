import { describe, expect, test } from "bun:test";
import { effortDefaults, runEffort } from "./models.ts";

describe("effortDefaults", () => {
  test.each([
    {
      name: "the model's own level in the settings",
      settings: {
        effortLevel: "low" as const,
        modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" as const } },
      },
      expected: "xhigh",
    },
    {
      name: "the settings' level for every model",
      settings: { effortLevel: "low" as const },
      expected: "low",
    },
    { name: "no level in the settings", settings: {}, expected: "high" },
  ])("starts a model with effort from $name", ({ settings, expected }) => {
    const defaults = effortDefaults(settings);

    expect(defaults("claude-opus-5-5")).toBe(expected);
  });

  test("gives a model without effort no level", () => {
    const defaults = effortDefaults({ effortLevel: "low" });

    expect(defaults("claude-haiku-4-5")).toBeNull();
  });
});

describe("runEffort", () => {
  test.each([
    { name: "a level the model runs", picked: "max" as const, expected: "max" },
    { name: "no level", picked: null, expected: "medium" },
  ])("runs a thread with $name picked at $expected", ({ picked, expected }) => {
    const effort = runEffort(
      "claude-sonnet-5",
      picked,
      effortDefaults({ effortLevel: "medium" }),
    );

    expect(effort).toBe(expected);
  });

  test("runs a model without effort at no level whatever was picked", () => {
    const effort = runEffort(
      "claude-haiku-4-5",
      "max",
      effortDefaults({ effortLevel: "medium" }),
    );

    expect(effort).toBeNull();
  });
});
