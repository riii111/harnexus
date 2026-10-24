import { dirname, join } from "node:path";
import { readClaudeLogin } from "../infra/claude/session.ts";
import { isVerifiedCodex } from "../infra/codex/versions.ts";
import { openThreadStore } from "../infra/thread-store.ts";
import { loadLogPath, loadStatePath } from "../runtime/config.ts";
import {
  checkAccess,
  readFileSlice,
  readTextFileIfExists,
  statFileIfExists,
} from "../runtime/fs.boundary.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import { readCommandOutput } from "../runtime/process.boundary.ts";
import { compatibilityCheck } from "./compatibility-report.ts";
import {
  type Check,
  fallbackCheck,
  logChecks,
  parseProcesses,
  processChecks,
} from "./doctor-report.ts";
import { readLaunchd } from "./launchd.boundary.ts";
import { registrationChecks } from "./launchd-plan.ts";
import { registeredEnvironment } from "./open-app-plan.ts";

// The checks change nothing but create the store's marker directory when it is missing, as the bridge does, so the command is safe while the app runs; nothing it prints holds conversation text or credentials.
const REPO = join(import.meta.dir, "..", "..");
const LOG_TAIL_BYTES = 2 * 1024 * 1024;

// The setup is this shell's for doctor, and the one the app was opened with for a feedback report.
export type DoctorSetup = {
  env: Record<string, string | undefined>;
  app: string;
  source: "shell" | "launchd";
};

export const shellSetup = (): DoctorSetup => ({
  env: process.env,
  app: process.env.HARNEXUS_APP_PATH || DEFAULT_APP,
  source: "shell",
});

export const DEFAULT_APP = "/Applications/ChatGPT.app";

export const CODEX_IN_APP =
  "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

// Independent checks run at once, since asking Claude Code about the login alone can take many seconds; the order of the report stays fixed.
export const doctorChecks = async (setup: DoctorSetup): Promise<Check[]> =>
  (
    await Promise.all([
      appCheck(setup).then((check) => [check]),
      codexCheck(setup).then((check) => [check]),
      sdkCheck().then((check) => [check]),
      bunCheck().then((check) => [check]),
      loginCheck().then((check) => [check]),
      stateChecks(setup),
      launcherCheck().then((check) => [check]),
      launchdChecks(setup),
      processesChecks(),
      logSummaryChecks(setup),
      lastFallbackCheck(setup).then((check) => [check]),
      lastCompatibilityCheck(setup).then((check) => [check]),
    ])
  ).flat();

async function appCheck(setup: DoctorSetup): Promise<Check> {
  const read = await readCommandOutput("/usr/bin/plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    join(setup.app, "Contents", "Info.plist"),
  ]);
  return read.isOk()
    ? {
        status: "ok",
        name: "App",
        detail: `${read.value.trim()} at ${setup.app}`,
      }
    : {
        status: "fail",
        name: "App",
        detail: `cannot read the version of ${setup.app}`,
      };
}

// The app bundles the Codex CLI the launcher hands over to, so its version is what the bridge's rewrites meet.
async function codexCheck(setup: DoctorSetup): Promise<Check> {
  const codex = setup.env.HARNEXUS_CODEX_PATH || join(setup.app, CODEX_IN_APP);
  const read = await readCommandOutput(codex, ["--version"]);
  if (read.isErr()) {
    return { status: "fail", name: "Codex CLI", detail: `cannot run ${codex}` };
  }
  const version = /(\d+\.\d+\.\d+\S*)/.exec(read.value)?.[1] ?? null;
  return isVerifiedCodex(version)
    ? { status: "ok", name: "Codex CLI", detail: `${version}` }
    : {
        status: "warn",
        name: "Codex CLI",
        detail: `${version ?? "unknown version"} is not a version harnexus was checked on`,
      };
}

async function sdkCheck(): Promise<Check> {
  const version = await packageVersion(
    join(REPO, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
  );
  return version === null
    ? {
        status: "fail",
        name: "Claude Agent SDK",
        detail: "not installed; run bun install",
      }
    : { status: "ok", name: "Claude Agent SDK", detail: version };
}

async function bunCheck(): Promise<Check> {
  const text = await readTextFileIfExists(join(REPO, "package.json"));
  const parsed =
    text.isOk() && text.value !== null ? parseJson(text.value) : null;
  const manager =
    parsed?.isOk() && isObject(parsed.value)
      ? parsed.value.packageManager
      : undefined;
  const pinned =
    typeof manager === "string" ? manager.replace(/^bun@/, "") : "";
  return pinned === Bun.version
    ? { status: "ok", name: "Bun", detail: Bun.version }
    : {
        status: "warn",
        name: "Bun",
        detail: `${Bun.version} runs this, while harnexus pins ${pinned || "no version"}`,
      };
}

async function loginCheck(): Promise<Check> {
  const login = await readClaudeLogin();
  return login.isOk()
    ? { status: "ok", name: "Claude login", detail: login.value }
    : {
        status: "fail",
        name: "Claude login",
        detail: `${login.error._tag}: ${login.error.message}`,
      };
}

async function stateChecks(setup: DoctorSetup): Promise<Check[]> {
  const path = loadStatePath(setup.env);
  if (path.isErr()) {
    return [{ status: "fail", name: "State file", detail: path.error.message }];
  }
  const store = await openThreadStore(path.value);
  const writable = await checkAccess(dirname(path.value), "write");
  return [
    store.isOk()
      ? {
          status: "ok",
          name: "State file",
          detail: `${path.value} is readable (as ${setup.source === "shell" ? "this shell's" : "the app's"} environment sets it)`,
        }
      : {
          status: "fail",
          name: "State file",
          detail: `${store.error._tag}: ${store.error.message}`,
        },
    writable.isOk()
      ? {
          status: "ok",
          name: "State directory",
          detail: `${dirname(path.value)} is writable`,
        }
      : {
          status: "fail",
          name: "State directory",
          detail: writable.error.message,
        },
  ];
}

async function launcherCheck(): Promise<Check> {
  const launcher = join(REPO, "bin", "harnexus-codex");
  const runnable = await checkAccess(launcher, "execute");
  return runnable.isOk()
    ? {
        status: "ok",
        name: "Launcher",
        detail: `executable at ${launcher}`,
      }
    : { status: "fail", name: "Launcher", detail: runnable.error.message };
}

async function processesChecks(): Promise<Check[]> {
  const listed = await readCommandOutput("/bin/ps", [
    "-axo",
    "pid=,ppid=,command=",
  ]);
  return listed.isOk()
    ? processChecks(parseProcesses(listed.value), REPO)
    : [{ status: "fail", name: "Processes", detail: "cannot list processes" }];
}

// The bridge finds its log as the app's environment sets it, which matches this shell's when the app was opened with bun run open-app.
async function logSummaryChecks(setup: DoctorSetup): Promise<Check[]> {
  const path = loadStatePath(setup.env).andThen((statePath) =>
    loadLogPath(setup.env, statePath),
  );
  if (path.isErr()) {
    return [{ status: "warn", name: "Log", detail: path.error.message }];
  }
  if (path.value === null) {
    return [
      {
        status: "warn",
        name: "Log",
        detail:
          "HARNEXUS_LOG_PATH is off; unset it and reopen the app with bun run open-app to keep a log",
      },
    ];
  }
  const { path: logPath } = path.value;
  const text = await readLogTail(logPath);
  if (text === null) {
    return [
      {
        status: "warn",
        name: "Log",
        detail: `cannot read ${logPath}; the bridge writes it once the app runs with harnexus and HARNEXUS_LOG_PATH is not off`,
      },
    ];
  }
  return logChecks(text, logPath, Date.now());
}

// A bridge running long, or a log set by hand that keeps every relayed message, can grow well past the rotation limit, so only its end is read; a line cut at the start is skipped as unparsable.
async function readLogTail(path: string) {
  const found = await statFileIfExists(path);
  if (found.isErr() || found.value === null) return null;
  const start = Math.max(0, found.value.size - LOG_TAIL_BYTES);
  const read = await readFileSlice(path, start, found.value.size - start);
  return read.isOk() ? read.value : null;
}

async function packageVersion(path: string) {
  const text = await readTextFileIfExists(path);
  if (text.isErr() || text.value === null) return null;
  const parsed = parseJson(text.value);
  return parsed.isOk() &&
    isObject(parsed.value) &&
    typeof parsed.value.version === "string"
    ? parsed.value.version
    : null;
}

async function launchdChecks(setup: DoctorSetup): Promise<Check[]> {
  const read = await readLaunchd();
  if (read.isErr())
    return [{ status: "fail", name: "launchd", detail: read.error.message }];
  return registrationChecks(
    registeredEnvironment(
      {
        app: setup.app,
        launcher: join(REPO, "bin", "harnexus-codex"),
        codex: setup.env.HARNEXUS_CODEX_PATH || join(setup.app, CODEX_IN_APP),
        bun: process.execPath,
      },
      setup.env,
    ),
    read.value.env,
    read.value.agent,
  );
}

async function lastFallbackCheck(setup: DoctorSetup): Promise<Check> {
  const state = loadStatePath(setup.env);
  if (state.isErr())
    return {
      status: "warn",
      name: "Last standard fallback",
      detail: state.error.message,
    };
  const read = await readTextFileIfExists(
    join(dirname(state.value), "launcher-failure.json"),
  );
  if (read.isErr())
    return {
      status: "warn",
      name: "Last standard fallback",
      detail: "cannot read failure record",
    };
  if (read.value === null) return fallbackCheck(null);
  const parsed = parseJson(read.value);
  return fallbackCheck(parsed.isOk() ? parsed.value : {});
}

async function lastCompatibilityCheck(setup: DoctorSetup): Promise<Check> {
  const state = loadStatePath(setup.env);
  if (state.isErr())
    return {
      status: "warn",
      name: "Last protocol incompatibility",
      detail: state.error.message,
    };
  const read = await readTextFileIfExists(
    join(dirname(state.value), "compatibility-failure.json"),
  );
  if (read.isErr())
    return {
      status: "warn",
      name: "Last protocol incompatibility",
      detail: "cannot read failure record",
    };
  if (read.value === null) return compatibilityCheck(null);
  const parsed = parseJson(read.value);
  return compatibilityCheck(parsed.isOk() ? parsed.value : {});
}
