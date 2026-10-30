import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Result, TaggedError } from "better-result";
import { isObject } from "../../runtime/object.ts";

export class ClaudeRunFailed extends TaggedError("ClaudeRunFailed")<{
  // Whether the process may have reached the model; false when it never started.
  started: boolean;
  message: string;
}> {}

export type ClaudeRun = {
  status: number;
  stdout: string;
  stderr: string;
  // Why the process ended; anything but "exit" means its result is unknown.
  ended: "exit" | "timeout" | "output-limit";
};

const OUTPUT_LIMIT = 16 * 1024 * 1024;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return isObject(cause) && cause.code === "EPERM";
  }
};

export const processAlive = alive;

// The group is signalled, so a child the wrapper started does not outlive it.
const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
};

// The prompt goes in through stdin, so it never shows in the process list.
// The promise settles only once the process has exited: a timeout sends SIGTERM, then SIGKILL after the grace, and fails if it still lives.
export const runClaude = (
  file: string,
  args: readonly string[],
  input: string,
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
    killGraceMs: number;
  },
) => {
  let started = false;
  return Result.tryPromise({
    try: () =>
      new Promise<ClaudeRun>((resolve, reject) => {
        const child = spawn(file, [...args], {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
        let stdout = "";
        let stderr = "";
        let size = 0;
        let ended: ClaudeRun["ended"] = "exit";
        let exited = false;
        let escalation: ReturnType<typeof setTimeout> | undefined;
        let giveUp: ReturnType<typeof setTimeout> | undefined;
        const stop = (reason: "timeout" | "output-limit") => {
          if (ended !== "exit" || exited) return;
          ended = reason;
          const pid = child.pid;
          if (pid === undefined) return;
          signalGroup(pid, "SIGTERM");
          escalation = setTimeout(() => {
            signalGroup(pid, "SIGKILL");
            giveUp = setTimeout(() => {
              reject(new Error(`pid ${pid} did not exit after SIGKILL`));
            }, options.killGraceMs);
          }, options.killGraceMs);
        };
        const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
        const collect = (sink: "out" | "err") => (chunk: Buffer) => {
          size += chunk.length;
          if (size > OUTPUT_LIMIT) {
            stop("output-limit");
            return;
          }
          if (sink === "out") stdout += chunk.toString("utf8");
          else stderr += chunk.toString("utf8");
        };
        child.stdout.on("data", collect("out"));
        child.stderr.on("data", collect("err"));
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("spawn", () => {
          started = true;
        });
        child.stdin.on("error", () => {});
        child.stdin.end(input);
        child.once("close", (code) => {
          exited = true;
          clearTimeout(timer);
          clearTimeout(escalation);
          clearTimeout(giveUp);
          // Anything the wrapper left in its group goes with it.
          if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
          resolve({ status: code ?? 1, stdout, stderr, ended });
        });
      }),
    catch: (cause) =>
      new ClaudeRunFailed({
        started,
        message: `${file} did not finish: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
  });
};

// The SDK ships a claude binary per platform, which the bridge already runs signed in; it is found the way the package manager installed it.
export const bundledClaude = (
  resolve: (specifier: string) => string = (specifier) =>
    import.meta.resolve(specifier),
): string | null => {
  const found = Result.try(() =>
    resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    ),
  );
  if (found.isErr()) return null;
  return fileURLToPath(new URL("claude", found.value));
};
