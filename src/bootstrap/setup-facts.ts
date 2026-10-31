import { join } from "node:path";
import type { Result } from "better-result";
import { readTextFileIfExists } from "../runtime/fs.boundary.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import {
  type CommandFailed,
  readCommandOutput,
} from "../runtime/process.boundary.ts";
import { SDK_PACKAGE } from "./bridge-identity.ts";
import { readInstalledPackage, versionOf } from "./checkout.ts";
import { parseTimedProcesses, type TimedProcess } from "./feedback-report.ts";
import type { readLaunchd } from "./launchd.boundary.ts";

// What doctor and a feedback report both read, taken once so both show the same moment.
export type SetupFacts = {
  codex: { path: string; version: string | null } | null;
  sdk: { version: string | null; claudeCodeVersion: string | null };
  pinnedBun: string | null;
  dependencies: Record<string, string>;
  processes: Result<TimedProcess[], CommandFailed>;
  launchd: Awaited<ReturnType<typeof readLaunchd>>;
};

export const collectSetupFacts = async (
  repo: string,
  codexPath: string,
  launchd: SetupFacts["launchd"],
): Promise<SetupFacts> => {
  const [codex, sdk, manifest, processes] = await Promise.all([
    readCommandOutput(codexPath, ["--version"]).then((read) =>
      read.isOk()
        ? { path: codexPath, version: codexVersionOf(read.value) }
        : null,
    ),
    readInstalledPackage(repo, SDK_PACKAGE),
    readManifest(repo),
    readCommandOutput("/bin/ps", ["-axo", "pid=,ppid=,etime=,command="]).then(
      (read) => read.map(parseTimedProcesses),
    ),
  ]);
  return {
    codex,
    sdk,
    pinnedBun: pinnedBunOf(manifest),
    dependencies: isObject(manifest.dependencies)
      ? Object.fromEntries(
          Object.entries(manifest.dependencies).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {},
    processes,
    launchd,
  };
};

export const readPinnedBun = async (repo: string) =>
  pinnedBunOf(await readManifest(repo));

const pinnedBunOf = (manifest: Record<string, unknown>) => {
  const manager = manifest.packageManager;
  return typeof manager === "string" && manager.startsWith("bun@")
    ? versionOf(manager.slice("bun@".length))
    : null;
};

const codexVersionOf = (output: string) =>
  // The CLI prints its name before the version, as in "codex-cli 0.163.0-alpha.10.2".
  versionOf(/(\d+\.\d+\.\d+\S*)/.exec(output)?.[1]);

const readManifest = async (repo: string) => {
  const text = await readTextFileIfExists(join(repo, "package.json"));
  const parsed =
    text.isOk() && text.value !== null ? parseJson(text.value) : null;
  return parsed?.isOk() && isObject(parsed.value) ? parsed.value : {};
};
