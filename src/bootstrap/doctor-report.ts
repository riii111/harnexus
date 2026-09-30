export type Check = {
  status: "ok" | "warn" | "fail";
  name: string;
  detail: string;
};

export type ProcessEntry = { pid: number; ppid: number; command: string };

// Lines are what ps prints for "pid=,ppid=,command=", one process each.
export const parseProcesses = (output: string): ProcessEntry[] =>
  output.split("\n").flatMap((line) => {
    const matched = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return matched === null
      ? []
      : [
          {
            pid: Number(matched[1]),
            ppid: Number(matched[2]),
            command: matched[3] ?? "",
          },
        ];
  });

// A bridge whose app-server is gone is left under launchd (ppid 1), and so is a Claude process whose bridge is gone; only pids are shown, since a command line can carry a prompt.
// Only processes run from this checkout count, so another project's server or another tool's Claude is never offered for kill.
export const processChecks = (
  processes: readonly ProcessEntry[],
  repo: string,
): Check[] => {
  const bridge = `${repo}/src/bootstrap/main.ts`;
  const claude = `${repo}/node_modules/@anthropic-ai/claude-agent-sdk-`;
  const bridges = processes.filter(({ command }) => runs(command, bridge));
  const bridgePids = new Set(bridges.map(({ pid }) => pid));
  const claudes = processes.filter(
    ({ command }) => command.includes(claude) && CLAUDE_BINARY.test(command),
  );
  const leftBridges = bridges.filter(({ ppid }) => ppid === LAUNCHD);
  const leftClaudes = claudes.filter(({ ppid }) => ppid === LAUNCHD);
  const owned = claudes.filter(({ ppid }) => bridgePids.has(ppid));
  return [
    {
      status: leftBridges.length === 0 ? "ok" : "warn",
      name: "Bridges",
      detail:
        leftBridges.length === 0
          ? `${bridges.length} running`
          : `${bridges.length} running, ${leftBridges.length} left without an app-server; stop them with kill ${pids(leftBridges)}`,
    },
    {
      status: leftClaudes.length === 0 ? "ok" : "warn",
      name: "Claude processes",
      detail:
        leftClaudes.length === 0
          ? `${owned.length} run by a bridge`
          : `${owned.length} run by a bridge, ${leftClaudes.length} left without one; stop them with kill ${pids(leftClaudes)}`,
    },
  ];
};

export const formatReport = (checks: readonly Check[]) =>
  `${checks
    .map(
      ({ status, name, detail }) =>
        `${status.padEnd(STATUS_WIDTH)}${name}: ${detail}`,
    )
    .join("\n")}\n`;

export const failed = (checks: readonly Check[]) =>
  checks.some(({ status }) => status === "fail");

const pids = (entries: readonly ProcessEntry[]) =>
  entries.map(({ pid }) => pid).join(" ");

// The path must be a whole word of the command, so a checkout nested under another path does not match.
const runs = (command: string, path: string) =>
  ` ${command} `.includes(` ${path} `);

// The SDK starts the Claude Code binary it ships in its platform package.
const CLAUDE_BINARY = /claude-agent-sdk-[a-z0-9-]+\/claude(\s|$)/;

const LAUNCHD = 1;

const STATUS_WIDTH = 5;
