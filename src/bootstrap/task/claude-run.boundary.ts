import { spawn } from "node:child_process";
import { Result, TaggedError } from "better-result";
import { isObject } from "../../runtime/object.ts";

export class ClaudeRunFailed extends TaggedError("ClaudeRunFailed")<{
  // Whether the process may have reached the model; false when it never started.
  started: boolean;
  message: string;
}> {}

export type ClaudeRun = { status: number; stdout: string; stderr: string };

const OUTPUT_LIMIT = 16 * 1024 * 1024;

// The prompt goes in through stdin, so it never shows in the process list.
export const runClaude = (
  file: string,
  args: readonly string[],
  input: string,
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
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
        });
        let stdout = "";
        let stderr = "";
        let size = 0;
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("timed out"));
        }, options.timeoutMs);
        const collect = (sink: "out" | "err") => (chunk: Buffer) => {
          size += chunk.length;
          if (size > OUTPUT_LIMIT) {
            child.kill("SIGTERM");
            reject(new Error("output too large"));
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
          clearTimeout(timer);
          resolve({ status: code ?? 1, stdout, stderr });
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

// A lock owned by a process that no longer exists is stale.
export const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return isObject(cause) && cause.code === "EPERM";
  }
};
