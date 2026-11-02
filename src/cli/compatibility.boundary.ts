import { dirname, join } from "node:path";
import { Result } from "better-result";
import {
  compatibilityNotification,
  compatibilityRecord,
} from "../diagnostics/compatibility-report.ts";
import type { CompatibilityEvent } from "../infra/codex/protocol/compatibility.ts";
import { loadStatePath } from "../lib/config.ts";
import { prepareDirectory, writeFileAtomic } from "../lib/fs.boundary.ts";
import { startDetachedCommand } from "../lib/process.boundary.ts";

export const reportCompatibilityFailure = (
  event: CompatibilityEvent,
  env: Record<string, string | undefined>,
  notify = (script: string) =>
    startDetachedCommand("/usr/bin/osascript", ["-e", script]),
) =>
  Result.allAsync([
    saveFailure(event, env),
    notify(compatibilityNotification(event.reason)),
  ]);

const saveFailure = (
  event: CompatibilityEvent,
  env: Record<string, string | undefined>,
) =>
  Result.gen(async function* () {
    const path = yield* loadStatePath(env);
    yield* Result.await(prepareDirectory(dirname(path)));
    yield* Result.await(
      writeFileAtomic(
        join(dirname(path), "compatibility-failure.json"),
        `${JSON.stringify(compatibilityRecord(event, new Date().toISOString()))}\n`,
      ),
    );
    return Result.ok();
  });
