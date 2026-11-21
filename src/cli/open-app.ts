import { isAbsolute, join, resolve } from "node:path";

import { parseProcesses } from "../features/diagnostics/doctor-report.ts";
import { REPO } from "../features/diagnostics/repo.ts";
import { clearLegacyLaunchd } from "../infra/setup/launchd.boundary.ts";
import { isAppRunning, openArguments } from "../infra/setup/open-app-plan.ts";
import {
  loadCallSocketPath,
  loadLogPath,
  loadPermissionMode,
  loadStatePath,
} from "../lib/config.ts";
import { checkAccess } from "../lib/fs.boundary.ts";
import { readCommandOutput } from "../lib/process.boundary.ts";

// Opens the app with harnexus for this launch only, or with --standard as the app normally runs; either way the app must be quit first, since it reads its environment only at start.
const APP = resolve(
  process.env.HARNEXUS_APP_PATH || "/Applications/ChatGPT.app",
);
const flags = process.argv.slice(2);
const mode = flags.includes("--standard") ? "standard" : "harnexus";

const paths = {
  app: APP,
  launcher: join(REPO, "bin", "harnexus-codex"),
  codex:
    process.env.HARNEXUS_CODEX_PATH ||
    join(APP, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
  bun: process.execPath,
};

const unknown = flags.filter((flag) => flag !== "--standard");
if (unknown.length > 0) {
  process.stderr.write(`harnexus: unknown option ${unknown.join(" ")}\n`);
  process.exit(1);
}

// An earlier version's login-wide setup sends every Dock launch through harnexus, so it is cleared even when the running app refuses this run below.
const cleared = await clearLegacyLaunchd();
if (cleared.isErr()) {
  process.stderr.write(
    `harnexus: ${cleared.error.message}; cannot clear the login-wide setup an earlier harnexus registered, rerun open-app\n`,
  );
  process.exit(1);
}

if (cleared.value.variables.length > 0 || cleared.value.agent)
  process.stdout.write(
    "Cleared the login-wide setup an earlier harnexus registered.\n",
  );
if (cleared.value.kept.length > 0)
  process.stdout.write(
    `Kept ${cleared.value.kept.join(", ")}, which another tool registered with launchd.\n`,
  );

const problem = await findProblem();
if (problem !== null) {
  process.stderr.write(`harnexus: ${problem}\n`);
  process.exit(1);
}

const opened = await readCommandOutput(
  "/usr/bin/open",
  openArguments(paths, mode, process.env),
);
if (opened.isErr()) {
  process.stderr.write(`harnexus: cannot open ${APP}\n`);
  process.exit(1);
}

process.stdout.write(
  mode === "standard"
    ? `Opened ${APP} without harnexus. Run harnexus doctor to see that no bridge is left running.\n`
    : `Opened ${APP} with harnexus until it quits; opened from the Dock or Finder it runs as usual. Run harnexus doctor to check the setup.\n`,
);

async function findProblem() {
  const listed = await readCommandOutput("/bin/ps", [
    "-axo",
    "pid=,ppid=,command=",
  ]);
  if (listed.isErr())
    return "cannot list processes to see whether the app runs";
  if (isAppRunning(parseProcesses(listed.value), APP)) {
    return `quit ${APP} first, since it reads its environment only when it starts`;
  }

  if (mode === "standard") return null;
  // The bridge and the launcher refuse a relative path where nobody sees it, so it is refused here first.
  const permissionMode = loadPermissionMode(process.env);
  if (permissionMode.isErr()) return permissionMode.error.message;
  const state = loadStatePath(process.env);
  if (state.isErr()) return state.error.message;
  const log = loadLogPath(process.env, state.value);
  if (log.isErr()) return log.error.message;
  const socket = loadCallSocketPath(process.env, state.value);
  if (socket.isErr()) return socket.error.message;
  if (!isAbsolute(paths.codex)) {
    return "HARNEXUS_CODEX_PATH must be an absolute path";
  }

  for (const [name, path] of [
    ["the launcher", paths.launcher],
    ["the Codex CLI", paths.codex],
    ["Bun", paths.bun],
  ] as const) {
    if ((await checkAccess(path, "execute")).isErr()) {
      return `cannot run ${name} at ${path}`;
    }
  }

  return null;
}
