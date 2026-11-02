import { describe, expect, test } from "bun:test";
import { responseCompatibility } from "./compatibility.ts";

describe("responseCompatibility", () => {
  test.each([
    { name: "a missing result", response: {} },
    { name: "a non-object result", response: { result: [] } },
    { name: "a missing user agent", response: { result: {} } },
    {
      name: "a changed user-agent type",
      response: { result: { userAgent: 7 } },
    },
  ])("detects an incompatible initialize response with $name", ({
    response,
  }) => {
    expect(responseCompatibility("initialize", response)).toBe(
      "InitializeResponseChanged",
    );
  });
  test.each([
    { name: "a missing model array", result: {} },
    { name: "a changed model array type", result: { data: {} } },
    { name: "a null model", result: { data: [null] } },
    { name: "a missing model id", result: { data: [{ model: "gpt" }] } },
    { name: "a changed model id type", result: { data: [{ id: 7 }] } },
    { name: "a changed cursor type", result: { data: [], nextCursor: false } },
  ])("detects an incompatible model response with $name", ({ result }) => {
    expect(responseCompatibility("modelList", { result })).toBe(
      "ModelListResponseChanged",
    );
  });
  test.each([
    {
      name: "a minimal initialization",
      kind: "initialize" as const,
      result: { userAgent: "unknown" },
    },
    {
      name: "an extended initialization",
      kind: "initialize" as const,
      result: { userAgent: "fixture/1.0.0", addedField: {} },
    },
    {
      name: "an empty model list",
      kind: "modelList" as const,
      result: { data: [] },
    },
    {
      name: "a last model page",
      kind: "modelList" as const,
      result: { data: [{ id: "gpt", extra: true }], nextCursor: null },
    },
    {
      name: "another model page",
      kind: "modelList" as const,
      result: { data: [], nextCursor: "next", extra: 1 },
    },
  ])("accepts $name without validating unused fields", ({ kind, result }) => {
    expect(responseCompatibility(kind, { result })).toBeNull();
  });
  test.each([
    { kind: "initialize" as const },
    { kind: "modelList" as const },
  ])("does not classify an RPC error for $kind as a protocol change", ({
    kind,
  }) => {
    expect(
      responseCompatibility(kind, {
        error: { code: -32603, message: "not ready" },
      }),
    ).toBeNull();
  });
});
