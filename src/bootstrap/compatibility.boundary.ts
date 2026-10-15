import { dirname, join } from "node:path";
import { Result } from "better-result";
import type { CompatibilityEvent } from "../infra/codex/compatibility.ts";
import { loadStatePath } from "../runtime/config.ts";
import { prepareDirectory, writeFileAtomic } from "../runtime/fs.boundary.ts";
import { startDetachedCommand } from "../runtime/process.boundary.ts";
import {
  compatibilityNotification,
  compatibilityRecord,
} from "./compatibility-report.ts";

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
