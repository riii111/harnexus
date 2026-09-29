import { describe, expect, test } from "bun:test";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { type EffortSettings, effortRule } from "./models.ts";

describe("effortRule", () => {
  test.each<{ name: string; settings: EffortSettings; expected: EffortLevel }>([
    {
      name: "the model's own level in the settings",
      settings: {
        effortLevel: "low",
        modelSettings: { [OPUS]: { effortLevel: "xhigh" } },
      },
      expected: "xhigh",
    },
    {
      name: "the settings' level for every model",
      settings: { effortLevel: "low" },
      expected: "low",
    },
    { name: "no level in the settings", settings: {}, expected: "high" },
  ])("runs a thread with no level picked at $name", ({
    settings,
    expected,
  }) => {
    const rule = effortRule(settings);

    expect(rule(OPUS, null)).toBe(expected);
  });

  test("runs a thread at its picked level over the settings' level", () => {
    const rule = effortRule({ effortLevel: "low" });

    expect(rule(OPUS, "max")).toBe("max");
  });

  test.each<{
    name: string;
    settings: EffortSettings;
    picked: "max" | null;
    expected: EffortLevel;
  }>([
    {
      name: "a picked level above the settings' cap",
      settings: { maxEffortLevel: "low" },
      picked: "max",
      expected: "low",
    },
    {
      name: "the default above the settings' cap",
      settings: { effortLevel: "high", maxEffortLevel: "medium" },
      picked: null,
      expected: "medium",
    },
    {
      name: "a picked level under the model's own cap of max",
      settings: {
        maxEffortLevel: "low",
        modelSettings: { [OPUS]: { maxEffortLevel: "max" } },
      },
      picked: "max",
      expected: "max",
    },
  ])("runs $name at $expected", ({ settings, picked, expected }) => {
    const rule = effortRule(settings);

    expect(rule(OPUS, picked)).toBe(expected);
  });

  test("runs a model without effort at no level whatever was picked", () => {
    const rule = effortRule({ effortLevel: "low" });

    expect(rule("claude-haiku-4-5", "max")).toBeNull();
  });
});

const OPUS = "claude-opus-5-5";
