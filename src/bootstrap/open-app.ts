import { isAbsolute, join, resolve } from "node:path";
import { loadLogPath, loadStatePath } from "../runtime/config.ts";
import { checkAccess } from "../runtime/fs.boundary.ts";
import { readCommandOutput } from "../runtime/process.boundary.ts";
import { parseProcesses } from "./doctor-report.ts";
import { isAppRunning, openArguments } from "./open-app-plan.ts";

// Opens the app with harnexus, or with --standard as the app normally runs; either way the app must be quit first, since it reads its environment only at start.
const REPO = join(import.meta.dir, "..", "..");
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
    ? `Opened ${APP} without harnexus. Run bun run doctor to see that no bridge is left running.\n`
    : `Opened ${APP} with harnexus. Run bun run doctor to check the setup.\n`,
);

async function findProblem() {
  const unknown = flags.filter((flag) => flag !== "--standard");
  if (unknown.length > 0) return `unknown option ${unknown.join(" ")}`;

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
  const log = loadLogPath(process.env);
  if (log.isErr()) return log.error.message;
  const state = loadStatePath(process.env);
  if (state.isErr()) return state.error.message;
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
