import { spawn } from "node:child_process";
import { Result, TaggedError } from "better-result";

export class CloudStartFailed extends TaggedError("CloudStartFailed")<{
  message: string;
}> {}

export type CloudStarted = { sessionId: string; title: string | null };

// Starts a Cloud session from a description with claude --cloud under script(1), reads the session it prints, and stops the CLI, leaving the session running.
export const startCloudSession = (
  claude: string,
  description: string,
  {
    cwd,
    env,
    timeoutMs = START_TIMEOUT_MS,
    platform = process.platform,
  }: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs?: number;
    platform?: NodeJS.Platform;
  },
) =>
  Result.tryPromise({
    try: () =>
      new Promise<CloudStarted>((resolve, reject) => {
        const command = [claude, "--cloud", description];
        // BSD script takes the command after the file; util-linux script takes one shell command line.
        const args =
          platform === "darwin"
            ? ["-q", "/dev/null", ...command]
            : ["-q", "-e", "-c", command.map(quote).join(" "), "/dev/null"];
        const child = spawn("script", args, {
          cwd,
          env: {
            ...env,
            TERM: env.TERM ?? "xterm-256color",
            // util-linux script runs the command line with $SHELL, which the quoting is written for.
            ...(platform === "darwin" ? {} : { SHELL: "/bin/sh" }),
          },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
        let seen = "";
        let settled = false;
        const finish = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (child.pid !== undefined) stopGroup(child.pid);
          outcome();
        };
        const timer = setTimeout(
          () =>
            finish(() =>
              reject(
                new Error(
                  lastLine(withoutEscapes(seen)) ??
                    "claude --cloud printed no session before the timeout",
                ),
              ),
            ),
          timeoutMs,
        );
        const read = (chunk: Buffer) => {
          seen = (seen + chunk.toString("utf8")).slice(-OUTPUT_KEPT);
          const plain = withoutEscapes(seen);
          const view = VIEW.exec(plain);
          if (view?.[1] !== undefined) {
            const title = CREATED.exec(plain)?.[1]?.trim() || null;
            const sessionId = view[1];
            finish(() => resolve({ sessionId, title }));
            return;
          }
          if (TRUST_PROMPT.test(plain))
            finish(() =>
              reject(
                new Error(
                  `claude asks whether to trust ${cwd}; open claude there once and trust it`,
                ),
              ),
            );
        };
        child.stdout.on("data", read);
        child.stderr.on("data", read);
        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", () =>
          finish(() =>
            reject(
              new Error(
                lastLine(withoutEscapes(seen)) ??
                  "claude --cloud ended without starting a session",
              ),
            ),
          ),
        );
      }),
    catch: (cause) =>
      new CloudStartFailed({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const stopGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGINT");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, KILL_AFTER_MS).unref();
};

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// Colors, cursor moves and other terminal controls, so the printed lines can be read.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CONTROL = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const TITLE_SET = new RegExp(`${ESC}\\][^${BEL}]*(${BEL}|${ESC}\\\\)`, "g");

const withoutEscapes = (text: string) =>
  text.replace(CONTROL, "").replace(TITLE_SET, "").replace(/\r/g, "\n");

const lastLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1) ?? null;

const VIEW =
  /View:\s*https:\/\/claude\.ai\/code\/((?:session|cse)_[A-Za-z0-9]{8,64})(?=[^A-Za-z0-9])/;
const CREATED = /Created cloud session:\s*([^\n]*)/;
const TRUST_PROMPT = /Is this a project you created or one you trust\?/;
const OUTPUT_KEPT = 64 * 1024;
const START_TIMEOUT_MS = 90_000;
const KILL_AFTER_MS = 3_000;
