import { join } from "node:path";
import { probeAppTools } from "../boundary/app-tools-probe.mjs";
import { parseJson } from "../boundary/json.ts";
import { readFirstLine } from "../boundary/process.ts";
import type { LogEvent } from "../shared/logger.ts";

export type AppToolsProbeEvent = {
  event: "app_tools_probe";
  via: ProbeVia;
  attempt: number;
  pid: number | null;
  ppid: number | null;
  socketExists: boolean;
  connected: boolean;
  sent: boolean;
  stage: ProbeStage;
  errorCode: string | null;
  tools: string[];
};

type ProbeVia = "bridge" | "child" | "grandchild";

type ProbeStage =
  | "pipe_missing"
  | "no_output"
  | "connect_failed"
  | "closed_before_response"
  | "error_response"
  | "invalid_response"
  | "responded"
  | "timeout";

export const PROBE_ENV = "HARNEXUS_PROBE_APP_TOOLS";

// Diagnoses why the app's tool socket rejects codex_app behind the bridge, from each process depth codex_app can run at; the delayed second attempt hints whether the rejection is limited to startup.
export const startAppToolsProbe = (
  env: NodeJS.ProcessEnv,
  log: (entry: LogEvent) => void,
  { delayMs = LATER_ATTEMPT_DELAY_MS } = {},
) => {
  if (env[PROBE_ENV] !== "1") return Promise.resolve();
  const pipePath = env.CODEX_APP_TOOLS_PIPE_PATH ?? "";
  if (pipePath === "") {
    log(failed("bridge", 0, "pipe_missing"));
    return Promise.resolve();
  }
  const node = env.CODEX_MCP_NODE_PATH || process.execPath;
  const attempt = async (count: number) => {
    const own = await probeAppTools(pipePath, TIMEOUT_MS);
    log(
      event("bridge", count, { pid: process.pid, ppid: process.ppid, ...own }),
    );
    for (const [via, depth] of DESCENDANTS) {
      const line = await readFirstLine(
        node,
        [PROBE_SCRIPT, String(depth)],
        env,
        TIMEOUT_MS * 2,
      );
      log(fromLine(via, count, line));
    }
  };
  return attempt(1)
    .then(() => new Promise((resolve) => setTimeout(resolve, delayMs)))
    .then(() => attempt(2));
};

const fromLine = (via: ProbeVia, attempt: number, line: string | null) => {
  if (line === null) return failed(via, attempt, "no_output");
  const parsed = parseJson(line);
  if (parsed.isErr()) return failed(via, attempt, "no_output");
  return event(via, attempt, parsed.value as Record<string, unknown>);
};

const event = (
  via: ProbeVia,
  attempt: number,
  outcome: Record<string, unknown>,
): AppToolsProbeEvent => ({
  event: "app_tools_probe",
  via,
  attempt,
  pid: typeof outcome.pid === "number" ? outcome.pid : null,
  ppid: typeof outcome.ppid === "number" ? outcome.ppid : null,
  socketExists: outcome.socketExists === true,
  connected: outcome.connected === true,
  sent: outcome.sent === true,
  stage: STAGES.has(outcome.stage as ProbeStage)
    ? (outcome.stage as ProbeStage)
    : "invalid_response",
  errorCode:
    typeof outcome.errorCode === "string" && ERROR_CODE.test(outcome.errorCode)
      ? outcome.errorCode
      : null,
  tools: Array.isArray(outcome.tools)
    ? outcome.tools.filter(
        (name): name is string =>
          typeof name === "string" && TOOL_NAME.test(name),
      )
    : [],
});

const failed = (via: ProbeVia, attempt: number, stage: ProbeStage) =>
  event(via, attempt, { stage });

const DESCENDANTS: readonly (readonly [ProbeVia, number])[] = [
  ["child", 0],
  ["grandchild", 1],
];
const STAGES = new Set<ProbeStage>([
  "pipe_missing",
  "no_output",
  "connect_failed",
  "closed_before_response",
  "error_response",
  "invalid_response",
  "responded",
  "timeout",
]);
const PROBE_SCRIPT = join(
  import.meta.dir,
  "..",
  "boundary",
  "app-tools-probe.mjs",
);
const ERROR_CODE = /^E[A-Z]{1,31}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const TIMEOUT_MS = 5000;
const LATER_ATTEMPT_DELAY_MS = 20_000;
