import {
  type CompatibilityEvent,
  compatibilityVersion,
} from "../infra/codex/compatibility.ts";
import { isObject } from "../runtime/object.ts";
import type { Check } from "./doctor-report.ts";

export const compatibilityRecord = (
  event: CompatibilityEvent,
  time: string,
) => ({
  event: "codex_incompatible" as const,
  reason: event.reason,
  version: compatibilityVersion(event.version),
  time,
});

export const compatibilityNotification = (
  reason: CompatibilityEvent["reason"],
) =>
  `display notification "${reason === "InitializeResponseChanged" ? "Codex の初期化応答" : "Codex のモデル一覧応答"}の形式が変わったため、Claude を無効にしました。bun run doctor で詳細を確認してください。" with title "harnexus を使えません"`;

export const compatibilityCheck = (record: unknown): Check => {
  const name = "Last protocol incompatibility";
  if (record === null) return { status: "ok", name, detail: "none recorded" };
  if (
    !isObject(record) ||
    record.event !== "codex_incompatible" ||
    (record.reason !== "InitializeResponseChanged" &&
      record.reason !== "ModelListResponseChanged") ||
    typeof record.time !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(record.time)
  )
    return { status: "warn", name, detail: "invalid failure record" };
  const safe = compatibilityRecord(
    {
      event: "codex_incompatible",
      reason: record.reason,
      version: typeof record.version === "string" ? record.version : null,
    },
    record.time,
  );
  return {
    status: "warn",
    name,
    detail: `${safe.time}: ${safe.reason}; Codex CLI ${safe.version ?? "unknown"}; Claude disabled for that connection`,
  };
};
