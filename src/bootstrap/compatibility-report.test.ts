import { describe, expect, test } from "bun:test";
import {
  compatibilityCheck,
  compatibilityNotification,
  compatibilityRecord,
} from "./compatibility-report.ts";

describe("compatibilityNotification", () => {
  test.each([
    { reason: "InitializeResponseChanged" as const, expected: "初期化応答" },
    { reason: "ModelListResponseChanged" as const, expected: "モデル一覧応答" },
  ])("explains $reason and the next action without claiming a direct restart", ({
    reason,
    expected,
  }) => {
    const script = compatibilityNotification(reason);
    expect(script).toContain(expected);
    expect(script).toContain("Claude を無効にしました");
    expect(script).toContain("bun run doctor");
    expect(script).not.toContain("起動しました");
  });
});

describe("compatibilityRecord", () => {
  test("drops private extra fields and unsafe version text", () => {
    const record = compatibilityRecord(
      {
        event: "codex_incompatible",
        reason: "InitializeResponseChanged",
        version: "/private/token",
        ...{ content: "secret" },
      },
      "2026-10-16T01:00:00.000Z",
    );
    expect(record).toEqual({
      event: "codex_incompatible",
      reason: "InitializeResponseChanged",
      version: null,
      time: "2026-10-16T01:00:00.000Z",
    });
  });
});

describe("compatibilityCheck", () => {
  test("shows the last recorded protocol failure with only safe metadata", () => {
    const check = compatibilityCheck({
      event: "codex_incompatible",
      reason: "ModelListResponseChanged",
      version: "1.0.0",
      time: "2026-10-16T01:00:00.000Z",
      content: "secret",
    });
    expect(check).toEqual({
      status: "warn",
      name: "Last protocol incompatibility",
      detail:
        "2026-10-16T01:00:00.000Z: ModelListResponseChanged; Codex CLI 1.0.0; Claude disabled for that connection",
    });
  });
});
