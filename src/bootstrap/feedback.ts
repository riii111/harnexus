import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadLogPath, loadStatePath } from "../runtime/config.ts";
import {
  listFilesDeepIfExists,
  readFileSlice,
  readTextFileIfExists,
  statFileIfExists,
} from "../runtime/fs.boundary.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";
import { readCommandOutput, runCommand } from "../runtime/process.boundary.ts";
import { bridgeSettings, SDK_PACKAGE } from "./bridge-identity.ts";
import {
  readCheckoutHead,
  readInstalledPackage,
  versionOf,
} from "./checkout.ts";
import {
  CODEX_IN_APP,
  DEFAULT_APP,
  type DoctorSetup,
  doctorChecks,
  shellSetup,
} from "./doctor-checks.ts";
import {
  type LoggedStart,
  loggedStarts,
  parseLog,
  selectLog,
} from "./feedback-log.ts";
import {
  appStartedAt,
  classifyChanges,
  DEFAULT_WINDOW_MS,
  type DependencyState,
  type FeedbackFacts,
  findBridges,
  formatFeedback,
  type GitChanges,
  type LogFacts,
  parseTimeArgument,
  parseTimedProcesses,
  redactPaths,
} from "./feedback-report.ts";
import { readLaunchd } from "./launchd.boundary.ts";

// Gathers what a bug report needs into one text to paste; like doctor it changes nothing but the thread store's marker directory, and nothing it prints holds conversation text, code or credentials.
const REPO = join(import.meta.dir, "..", "..");
const LAUNCHER = join(REPO, "bin", "harnexus-codex");
const NEW_ISSUE =
  "https://github.com/riii111/harnexus/issues/new?template=bug-report.yml";
// GitHub refuses an issue body over 65,536 characters, and the form's other fields need room too.
const LOG_BUDGET_CHARS = 36_000;
const LOG_READ_LIMIT_BYTES = 32 * 1024 * 1024;
const LOG_CHUNK_BYTES = 1024 * 1024;
const PUBLIC_ROOTS = [
  "/opt/homebrew/",
  "/usr/local/",
  "/usr/bin/",
  "/bin/",
  "/nix/store/",
];

const now = Date.now();
const args = readArgs(process.argv.slice(2));
if (args === null) {
  process.stderr.write(
    "usage: bun run feedback [--since 30m|2h|3d|<time>] [--until <duration or time>]\n",
  );
  process.exit(2);
}
const since = parseTimeArgument(
  "--since",
  args.since,
  now,
  now - DEFAULT_WINDOW_MS,
);
const until = parseTimeArgument("--until", args.until, now, now);
if (since.isErr() || until.isErr() || since.value > until.value) {
  process.stderr.write(
    `harnexus: ${since.isErr() ? since.error.message : until.isErr() ? until.error.message : "--since must come before --until"}\n`,
  );
  process.exit(2);
}
const window = { sinceMs: since.value, untilMs: until.value };
process.stderr.write(
  "Collecting the report; asking Claude Code about the login can take up to half a minute.\n",
);

const { setup, launchd } = await appSetup();
const processes = await readCommandOutput("/bin/ps", [
  "-axo",
  "pid=,ppid=,etime=,command=",
]).then((read) => (read.isOk() ? parseTimedProcesses(read.value) : []));
const bridges = findBridges(processes, REPO, now);
const running = new Set(bridges.mine.map(({ pid }) => pid));
const [
  doctor,
  head,
  sdk,
  dependencies,
  changes,
  macos,
  installedCodex,
  bun,
  codeChangedAt,
  log,
] = await Promise.all([
  doctorChecks(setup),
  readCheckoutHead(REPO),
  readInstalledPackage(REPO, SDK_PACKAGE),
  dependencyStates(),
  gitChanges(),
  process.platform === "darwin"
    ? readCommandOutput("/usr/bin/sw_vers", ["-productVersion"]).then((read) =>
        read.isOk() ? read.value.trim() : null,
      )
    : null,
  readCommandOutput(
    setup.env.HARNEXUS_CODEX_PATH || join(setup.app, CODEX_IN_APP),
    ["--version"],
  ).then((read) =>
    read.isOk() ? versionOf(/(\d+\.\d+\.\d+\S*)/.exec(read.value)?.[1]) : null,
  ),
  registeredBun(),
  newestCodeChange(),
  readAppLog(running),
]);

const facts: FeedbackFacts = {
  nowMs: now,
  offsetMinutes: -new Date(now).getTimezoneOffset(),
  sinceMs: window.sinceMs,
  untilMs: window.untilMs,
  platform: {
    macos: macos !== null && /^\d+(\.\d+){0,3}$/.test(macos) ? macos : null,
    arch: process.arch,
  },
  head,
  current: { sdk: sdk.version, claudeCode: sdk.claudeCodeVersion },
  changes,
  dependencies,
  codeChangedAtMs: codeChangedAt,
  bridges,
  loggedStarts: log.starts.filter(({ pid }) => running.has(pid)),
  setup: {
    launchd,
    otherCheckout:
      setup.source === "launchd" &&
      setup.env.CODEX_CLI_PATH !== undefined &&
      setup.env.CODEX_CLI_PATH !== LAUNCHER,
    settings: bridgeSettings(setup.env),
    bun,
    pinnedBun: await pinnedBun(),
  },
  app: {
    startedAtMs: appStartedAt(processes, setup.app, now),
    installedCodex,
    runningCodex: [
      ...new Set(
        log.starts
          .filter(({ pid }) => running.has(pid))
          .map(({ codex }) => codex)
          .filter((version) => version !== null),
      ),
    ],
  },
  doctor,
  log: log.facts,
};

// A pipe takes a long report in several writes, so the exit waits until all of it is handed over.
await new Promise((resolve) =>
  process.stdout.write(
    redactPaths(formatFeedback(facts), knownPaths(setup)),
    resolve,
  ),
);
process.stderr.write(
  `Read the report, then paste all of it into the Feedback report field at ${NEW_ISSUE}\n`,
);
process.exit(0);

function readArgs(argv: readonly string[]) {
  const values: { since?: string; until?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const matched = /^--(since|until)(?:=(.*))?$/.exec(arg);
    if (matched === null) return null;
    let value = matched[2];
    if (value === undefined) {
      index += 1;
      value = argv[index];
    }
    if (value === undefined || value === "") return null;
    values[matched[1] as "since" | "until"] = value;
  }
  return values;
}

// The app runs with what open-app registered with launchd, and a variable launchd lacks takes its default there rather than this shell's value.
async function appSetup(): Promise<{
  setup: DoctorSetup;
  launchd: "registered" | "none" | "unreadable";
}> {
  const shell = shellSetup();
  const launchd = await readLaunchd();
  if (launchd.isErr()) return { setup: shell, launchd: "unreadable" };
  const env = launchd.value.env;
  if (Object.keys(env).length === 0) return { setup: shell, launchd: "none" };
  const codex = env.HARNEXUS_CODEX_PATH;
  const suffix = `/${CODEX_IN_APP}`;
  return {
    setup: {
      env,
      app: codex?.endsWith(suffix) ? codex.slice(0, -suffix.length) : shell.app,
      source: "launchd",
    },
    launchd: "registered",
  };
}

async function registeredBun() {
  const path = setup.source === "launchd" ? setup.env.HARNEXUS_BUN_PATH : null;
  if (path === undefined || path === null) return null;
  const read = await readCommandOutput(path, ["--version"]);
  return { path, version: read.isOk() ? versionOf(read.value.trim()) : null };
}

async function packageManifest() {
  const text = await readTextFileIfExists(join(REPO, "package.json"));
  const parsed =
    text.isOk() && text.value !== null ? parseJson(text.value) : null;
  return parsed?.isOk() && isObject(parsed.value) ? parsed.value : {};
}

async function pinnedBun() {
  const manager = (await packageManifest()).packageManager;
  return typeof manager === "string" && manager.startsWith("bun@")
    ? manager.slice("bun@".length)
    : null;
}

async function dependencyStates(): Promise<DependencyState[]> {
  const dependencies = (await packageManifest()).dependencies;
  if (!isObject(dependencies)) return [];
  return Promise.all(
    Object.entries(dependencies)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
      .map(async ([name, pinned]) => ({
        name,
        pinned,
        installed: (await readInstalledPackage(REPO, name)).version,
      })),
  );
}

// On macOS /usr/bin/git without the developer tools opens an install dialog, so it runs only once xcode-select finds them; optional locks are off so a report never takes the index lock.
async function gitChanges(): Promise<GitChanges | null> {
  const git = Bun.which("git");
  if (git === null) return null;
  if (process.platform === "darwin" && git === "/usr/bin/git") {
    const tools = await runCommand(
      "/usr/bin/xcode-select",
      ["-p"],
      process.env,
    );
    if (tools.isErr() || tools.value.status !== 0) return null;
  }
  const status = await runCommand(
    git,
    ["-C", REPO, "status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  );
  if (status.isErr() || status.value.status !== 0) return null;
  return classifyChanges(status.value.stdout);
}

// A bridge loads its code, the SDK and the launcher once at start, so a change to any of them after that leaves it on older code.
async function newestCodeChange() {
  const times: (number | null)[] = [];
  const listed = await listFilesDeepIfExists(join(REPO, "src"));
  const sources =
    listed.isOk() && listed.value !== null
      ? listed.value.filter(
          (path) =>
            path.endsWith(".ts") &&
            !path.endsWith(".test.ts") &&
            !path.split("/").includes("testing"),
        )
      : [];
  for (const path of [
    ...sources.map((source) => join(REPO, "src", source)),
    join(REPO, "bun.lock"),
    join(REPO, "package.json"),
    LAUNCHER,
    join(REPO, "node_modules", SDK_PACKAGE, "package.json"),
  ]) {
    const found = await statFileIfExists(path);
    times.push(found.isOk() ? (found.value?.modifiedMs ?? null) : null);
  }
  return maxOf(times);
}

// The current file and the one moved aside at a bridge start are read from the end back until a line older than the window, within a cap, so a long log never loads whole.
// A bridge writes what it runs only when it starts, so reading goes on back to the start line of each bridge running or writing in the window.
async function readAppLog(runningPids: ReadonlySet<number>) {
  const statePath = loadStatePath(setup.env);
  const path = statePath.andThen((state) => loadLogPath(setup.env, state));
  if (path.isErr())
    return unreadLog({ state: "unreadable", reason: path.error.message });
  if (path.value === null) return unreadLog({ state: "off" });
  const logPath = path.value.path;
  const coversWindow = (text: string) => firstTime(text) < window.sinceMs;
  let read = await readLogFiles(logPath, coversWindow);
  if (read === null)
    return unreadLog({
      state: "unreadable",
      reason: `cannot read ${logPath}; the bridge creates it once the app runs with harnexus`,
    });
  let parsed = parseLog(read.text);
  const started = new Set(loggedStarts(parsed.lines).map(({ pid }) => pid));
  const missing = [
    ...new Set([
      ...runningPids,
      ...parsed.lines
        .filter(({ timeMs }) => timeMs >= window.sinceMs)
        .map(({ pid }) => pid)
        .filter((pid) => pid !== null),
    ]),
  ].filter((pid) => !started.has(pid));
  if (missing.length > 0 && !read.reachedStart) {
    const further = await readLogFiles(
      logPath,
      (text) =>
        coversWindow(text) &&
        missing.every((pid) =>
          text.includes(`"pid":${pid},"event":"bridge_started"`),
        ),
    );
    if (further !== null) {
      read = further;
      parsed = parseLog(read.text);
    }
  }
  const oldest = parsed.lines[0]?.timeMs ?? null;
  const complete =
    read.reachedStart || (oldest !== null && oldest <= window.sinceMs);
  return {
    starts: loggedStarts(parsed.lines),
    facts: {
      state: "read",
      path: logPath,
      oldestMs: oldest,
      complete,
      unreadable: parsed.unreadable,
      leftOutFields: [...parsed.leftOutFields].sort(),
      selection: selectLog(parsed.lines, {
        sinceMs: window.sinceMs,
        untilMs: window.untilMs,
        runningPids,
        budget: LOG_BUDGET_CHARS,
      }),
    } satisfies LogFacts,
  };
}

async function readLogFiles(
  logPath: string,
  enough: (text: string) => boolean,
) {
  const texts: string[] = [];
  let budget = LOG_READ_LIMIT_BYTES;
  let reachedStart = true;
  const files = [logPath, `${logPath}.1`];
  for (const [index, file] of files.entries()) {
    const read = await readBack(file, enough, budget);
    if (read === null) continue;
    if (read.failed && read.text === "") return null;
    // The file moved aside ends where the current one begins, so its own cut last line is closed off rather than joined to the next.
    texts.unshift(
      texts.length === 0 || read.text.endsWith("\n") || read.text === ""
        ? read.text
        : `${read.text}\n`,
    );
    budget -= read.bytes;
    reachedStart = read.reachedStart;
    if (!read.reachedStart || enough(read.text) || budget <= 0) {
      // Lines left in an older file not read mean the start was not reached.
      const older = files[index + 1];
      if (reachedStart && older !== undefined) {
        const found = await statFileIfExists(older);
        if (found.isErr() || found.value !== null) reachedStart = false;
      }
      break;
    }
  }
  return texts.length === 0 ? null : { text: texts.join(""), reachedStart };
}

function unreadLog(facts: LogFacts) {
  return { starts: [] as LoggedStart[], facts };
}

// Text read from inside the file starts at its first line break, so the first line kept is whole; the last line may still be cut by a writer, which parseLog leaves out.
async function readBack(
  path: string,
  enough: (text: string) => boolean,
  limit: number,
) {
  const found = await statFileIfExists(path);
  if (found.isErr() || found.value === null) return null;
  const size = found.value.size;
  let start = size;
  let text = "";
  let failed = false;
  while (start > 0 && size - start < limit) {
    const next = Math.max(0, start - LOG_CHUNK_BYTES, size - limit);
    const chunk = await readFileSlice(path, next, start - next);
    if (chunk.isErr()) {
      failed = true;
      break;
    }
    text = chunk.value + text;
    start = next;
    if (enough(wholeLines(text, start))) break;
  }
  const whole = wholeLines(text, start);
  return {
    text: whole,
    bytes: size - start,
    reachedStart: start === 0,
    failed,
  };
}

function wholeLines(text: string, start: number) {
  return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
}

function firstTime(text: string) {
  const line = text.slice(0, text.indexOf("\n"));
  const time = /"time":"([^"]+)"/.exec(line)?.[1];
  const ms = time === undefined ? Number.NaN : Date.parse(time);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

// A path set by hand can sit anywhere, so outside the home folder and the usual install places it prints by role.
function knownPaths(appSetup: DoctorSetup) {
  const home = homedir();
  const state = loadStatePath(appSetup.env);
  const log = state.andThen((path) => loadLogPath(appSetup.env, path));
  const custom = [
    { path: log.isOk() ? log.value?.path : undefined, name: "<log>" },
    { path: appSetup.env.HARNEXUS_CODEX_PATH, name: "<codex>" },
    { path: appSetup.env.HARNEXUS_BUN_PATH, name: "<bun>" },
    { path: appSetup.env.CODEX_CLI_PATH, name: "<launcher>" },
  ].filter(
    (entry): entry is { path: string; name: string } =>
      entry.path !== undefined &&
      !entry.path.startsWith(`${home}/`) &&
      !entry.path.startsWith(`${appSetup.app}/`) &&
      !entry.path.startsWith(`${REPO}/`) &&
      !PUBLIC_ROOTS.some((root) => entry.path?.startsWith(root)),
  );
  return [
    { path: REPO, name: "<checkout>" },
    ...(state.isOk() ? [{ path: dirname(state.value), name: "<state>" }] : []),
    ...custom,
    ...(appSetup.app === DEFAULT_APP
      ? []
      : [{ path: appSetup.app, name: "<app>" }]),
    { path: home, name: "~" },
  ];
}

function maxOf(times: readonly (number | null)[]) {
  const known = times.filter((time): time is number => time !== null);
  return known.length === 0 ? null : Math.max(...known);
}
