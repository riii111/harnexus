import { dirname } from "node:path";

import { Result } from "better-result";

import {
  cloudLinksPath,
  exportCloudLinks,
  mergeCloudLinks,
  parseCloudLinksExchange,
  readCloudLinks,
  updateCloudLinks,
} from "../infra/cloud-links.ts";
import {
  enterMaintenance,
  LOCK_DEPS,
  type LockDeps,
} from "../infra/state-locks.ts";
import { parseOptions } from "../lib/args.boundary.ts";
import { loadStatePath } from "../lib/config.ts";
import { readRegularTextFile } from "../lib/fs.boundary.ts";
import { EXIT } from "./call-client.ts";

export type StateRun = { code: number; stdout: string; stderr: string };

type Deps = {
  env: Record<string, string | undefined>;
  readStdin: () => Promise<string>;
  locks?: LockDeps;
};

export const STATE_USAGE = `  harnexus state export-cloud-links
  harnexus state import-cloud-links [--file FILE]
`;

// Offline operations on the state, run while the app and every bridge are stopped; they start no model and open no socket.
export const runState = async (
  args: readonly string[],
  deps: Deps,
): Promise<StateRun> => {
  const [operation, ...rest] = args;
  if (operation === "export-cloud-links") return exportLinks(rest, deps);
  if (operation === "import-cloud-links") return importLinks(rest, deps);
  return invalid(
    "expected an operation: export-cloud-links, import-cloud-links",
  );
};

const invalid = (message: string): StateRun => ({
  code: EXIT.invalid,
  stdout: "",
  stderr: `usage:\n${STATE_USAGE}harnexus state: ${message}\n`,
});

const refused = (
  outcome: "rejected" | "tool_error",
  message: string,
  extra: object = {},
): StateRun => ({
  code: EXIT[outcome],
  stdout: `${JSON.stringify({ outcome, message, ...extra })}\n`,
  stderr: `harnexus state: ${message}\n`,
});

// Runs the operation under the maintenance lock, which keeps bridges from starting until it is released.
const offline = async (
  deps: Deps,
  operation: (stateDir: string) => Promise<StateRun>,
) => {
  const statePath = loadStatePath(deps.env);
  if (statePath.isErr()) return invalid(statePath.error.message);
  const stateDir = dirname(statePath.value);
  const entered = await enterMaintenance(stateDir, deps.locks ?? LOCK_DEPS);
  if (entered.isErr())
    return refused(
      entered.error._tag === "StateLockFailed" ? "tool_error" : "rejected",
      entered.error.message,
    );
  try {
    return await operation(stateDir);
  } finally {
    await entered.value.release();
  }
};

const exportLinks = (args: readonly string[], deps: Deps) => {
  if (args.length > 0) return invalid("export-cloud-links takes no options");
  return offline(deps, async (stateDir) => {
    const read = await readCloudLinks(cloudLinksPath(stateDir));
    if (read.isErr()) return refused("tool_error", read.error.message);
    return {
      code: EXIT.done,
      stdout: exportCloudLinks(read.value),
      stderr: "",
    };
  });
};

const importLinks = async (args: readonly string[], deps: Deps) => {
  const options = parseOptions(args, { file: { type: "string" } });
  if (options.isErr()) return invalid(options.error.message);
  const file = options.value.file;
  const text =
    typeof file === "string"
      ? await readRegularTextFile(file)
      : Result.ok(await deps.readStdin());
  if (text.isErr()) return invalid(text.error.message);
  const offered = parseCloudLinksExchange(text.value);
  if (offered.isErr()) return invalid(offered.error.message);
  return offline(deps, async (stateDir) => {
    const now = (deps.locks ?? LOCK_DEPS).now();
    const merged = await updateCloudLinks(
      cloudLinksPath(stateDir),
      (state) => mergeCloudLinks(state, offered.value, now),
      deps.locks ?? LOCK_DEPS,
    );
    if (merged.isErr()) return refused("tool_error", merged.error.message);
    const result = merged.value;
    if (result.conflicts.length > 0)
      return refused(
        "rejected",
        "some sessions are already reserved for another chat; nothing was imported",
        { result },
      );
    return {
      code: EXIT.done,
      stdout: `${JSON.stringify({ outcome: "done", result })}\n`,
      stderr: "",
    };
  });
};
