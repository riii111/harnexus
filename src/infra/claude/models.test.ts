import { describe, expect, test } from "bun:test";
import type { EffortLevel, ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  createModelCatalog,
  type EffortSettings,
  effortRule,
  isClaudeModel,
  modelsFromSdk,
} from "./models.ts";

describe("isClaudeModel", () => {
  test.each([
    { name: "a listed model", model: "claude-opus-5-5", expected: true },
    {
      name: "a model Claude Code dropped",
      model: "claude-sonnet-5",
      expected: true,
    },
    { name: "a Codex model", model: "gpt-fixture", expected: false },
    { name: "a missing model", model: undefined, expected: false },
  ])("tells $name by its id", ({ model, expected }) => {
    expect(isClaudeModel(model)).toBe(expected);
  });
});

describe("modelsFromSdk", () => {
  test("pins an alias to the model it resolves to and names it with its version", () => {
    const models = modelsFromSdk([SONNET_ALIAS]);

    expect(models).toEqual([
      {
        id: "claude-sonnet-5-5",
        displayName: "Claude Sonnet 5.5",
        description: "Sonnet 5.5 · Efficient for routine tasks",
        efforts: ["low", "high"],
      },
    ]);
  });

  test("keeps an explicit id with its context suffix", () => {
    const models = modelsFromSdk([
      {
        ...SONNET_ALIAS,
        value: "claude-fable-5-1[1m]",
        resolvedModel: "claude-fable-5-1",
      },
    ]);

    expect(models.map(({ id }) => id)).toEqual(["claude-fable-5-1[1m]"]);
  });

  test("names a model whose description starts with something else from its display name", () => {
    const models = modelsFromSdk([
      {
        value: "claude-opus-5[1m]",
        displayName: "Opus 5 (1M context)",
        description: "Newer version available · select Opus for Opus 5.5",
      },
    ]);

    expect(models.map(({ displayName }) => displayName)).toEqual([
      "Claude Opus 5 (1M context)",
    ]);
  });

  test("names a model whose description has no version from its display name", () => {
    const models = modelsFromSdk([
      {
        value: "claude-opus-4-6[1m]",
        displayName: "Opus 4.6 (1M)",
        description: "Opus 4.6 with 1M context",
      },
    ]);

    expect(models.map(({ displayName }) => displayName)).toEqual([
      "Claude Opus 4.6 (1M)",
    ]);
  });

  test("leaves out the default row, a repeated model and a row without a Claude id", () => {
    const models = modelsFromSdk([
      { ...SONNET_ALIAS, value: "default" },
      SONNET_ALIAS,
      { ...SONNET_ALIAS, value: "sonnet-latest" },
      { value: "custom", displayName: "Custom", description: "Custom model" },
    ]);

    expect(models.map(({ id }) => id)).toEqual(["claude-sonnet-5-5"]);
  });

  test("gives a model without effort levels none", () => {
    const models = modelsFromSdk([
      {
        value: "haiku",
        resolvedModel: "claude-haiku-4-5-20251001",
        displayName: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
      },
    ]);

    expect(models.map(({ efforts }) => efforts)).toEqual([[]]);
  });
});

describe("createModelCatalog", () => {
  test("offers the built-in models until Claude Code's list is read", () => {
    const catalog = createModelCatalog();

    expect(catalog.models().offered.map(({ id }) => id)).toEqual(BUILT_IN_IDS);
    expect(catalog.models().retired).toEqual([]);
  });

  test("offers the listed models and keeps a built-in one the list drops as retired", () => {
    const catalog = createModelCatalog();

    catalog.replace(modelsFromSdk([SONNET_ALIAS, OPUS_ALIAS]));

    expect({
      offered: catalog.models().offered.map(({ id }) => id),
      retired: catalog.models().retired.map(({ id }) => id),
    }).toEqual({
      offered: ["claude-sonnet-5-5", "claude-opus-5-5"],
      retired: ["claude-sonnet-5", "claude-haiku-4-5"],
    });
  });

  test.each([
    { name: "the list is read", settle: (c: Catalog) => c.replace([]) },
    { name: "the list is given up", settle: (c: Catalog) => c.giveUp() },
  ])("lets a waiting turn go on once $name", async ({ settle }) => {
    const catalog = createModelCatalog();
    let settled = false;
    void catalog.settled().then(() => {
      settled = true;
    });
    await Bun.sleep(0);
    const before = settled;

    settle(catalog);
    await catalog.settled();

    expect({ before, after: settled }).toEqual({ before: false, after: true });
  });

  test("takes a listed model's levels over the built-in ones and keeps those of a retired model", () => {
    const catalog = createModelCatalog();

    catalog.replace(
      modelsFromSdk([{ ...OPUS_ALIAS, supportedEffortLevels: ["low"] }]),
    );

    expect({
      listed: catalog.effortsOf("claude-opus-5-5"),
      retired: catalog.effortsOf("claude-sonnet-5"),
      unknown: catalog.effortsOf("claude-unknown"),
    }).toEqual({
      listed: ["low"],
      retired: ["low", "medium", "high", "xhigh", "max"],
      unknown: [],
    });
  });
});

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
    const rule = effortRule(settings, BUILT_IN_EFFORTS);

    expect(rule(OPUS, null)).toBe(expected);
  });

  test("finds the settings of a model under its name without the context suffix", () => {
    const rule = effortRule(
      { modelSettings: { "claude-fable-5-1": { effortLevel: "low" } } },
      () => ["low", "high"],
    );

    expect(rule("claude-fable-5-1[1m]", null)).toBe("low");
  });

  test("runs a thread at its picked level over the settings' level", () => {
    const rule = effortRule({ effortLevel: "low" }, BUILT_IN_EFFORTS);

    expect(rule(OPUS, "max")).toBe("max");
  });

  test("runs a picked level the model does not list at the default", () => {
    const rule = effortRule({}, () => ["low", "medium", "high"]);

    expect(rule(OPUS, "max")).toBe("high");
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
    const rule = effortRule(settings, BUILT_IN_EFFORTS);

    expect(rule(OPUS, picked)).toBe(expected);
  });

  test("runs a model without effort at no level whatever was picked", () => {
    const rule = effortRule({ effortLevel: "low" }, BUILT_IN_EFFORTS);

    expect(rule("claude-haiku-4-5", "max")).toBeNull();
  });
});

type Catalog = ReturnType<typeof createModelCatalog>;

const OPUS = "claude-opus-5-5";

const BUILT_IN_IDS = ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"];

const BUILT_IN_EFFORTS = createModelCatalog().effortsOf;

const SONNET_ALIAS: ModelInfo = {
  value: "sonnet",
  resolvedModel: "claude-sonnet-5-5",
  displayName: "Sonnet",
  description: "Sonnet 5.5 · Efficient for routine tasks",
  supportsEffort: true,
  supportedEffortLevels: ["low", "high"],
};

const OPUS_ALIAS: ModelInfo = {
  value: "opus",
  resolvedModel: "claude-opus-5-5",
  displayName: "Opus",
  description: "Opus 5.5 · Best for everyday, complex tasks",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
};
