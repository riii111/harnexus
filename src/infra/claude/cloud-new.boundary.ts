import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { Result, TaggedError } from "better-result";

export class CloudStartFailed extends TaggedError("CloudStartFailed")<{
  message: string;
  // False only when claude never ran or stopped before starting anything, so starting again makes no second session.
  mayHaveStarted: boolean;
}> {}

class NotStarted extends Error {}

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
        // Started in Auto mode, a session and the workers it starts run most tools without stopping for a permission prompt no one here can answer.
        const command = [
          claude,
          "--cloud",
          description,
          "--permission-mode",
          "auto",
        ];
        // BSD script takes the command after the file and fails on a socket as its input, so it reads a pipe that stays open; util-linux script takes one shell command line.
        const [file, args] =
          platform === "darwin"
            ? [
                "/bin/sh",
                [
                  "-c",
                  // Once script ends, the group goes too, so the pipe's writer does not keep it running.
                  'sleep 86400 | { script -q /dev/null "$@"; kill 0; }',
                  "sh",
                  ...command,
                ],
              ]
            : [
                "script",
                ["-q", "-e", "-c", command.map(quote).join(" "), "/dev/null"],
              ];
        const child = spawn(file, args, {
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
        let spawned = false;
        child.once("spawn", () => {
          spawned = true;
        });
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
        // A chunk can end inside a character, which each stream's decoder holds until the rest arrives.
        const read = (decoder: StringDecoder) => (chunk: Buffer) => {
          seen = (seen + decoder.write(chunk)).slice(-OUTPUT_KEPT);
          const plain = withoutEscapes(seen);
          const view = VIEW.exec(plain);
          if (view?.[1] !== undefined) {
            const title = CREATED.exec(plain)?.[1]?.trim() || null;
            const sessionId = view[1];
            finish(() => resolve({ sessionId, title }));
            return;
          }

          if (TRUST_PROMPT.test(plain)) {
            finish(() =>
              reject(
                new NotStarted(
                  `claude asks whether to trust ${cwd}; open claude there once and trust it`,
                ),
              ),
            );
            return;
          }

          // No one here can answer a dialog, so waiting for the timeout only delays the same failure.
          const confirm = CONFIRM_PROMPT.exec(plain);
          if (confirm !== null) {
            const question = questionBefore(plain.slice(0, confirm.index));
            finish(() =>
              reject(
                new NotStarted(
                  `claude asks ${question === null ? "a question" : `"${question}"`} before starting in ${cwd}; open claude there once and answer it`,
                ),
              ),
            );
          }
        };

        child.stdout.on("data", read(new StringDecoder("utf8")));
        child.stderr.on("data", read(new StringDecoder("utf8")));
        child.on("error", (error) =>
          finish(() => reject(spawned ? error : new NotStarted(error.message))),
        );
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
        mayHaveStarted: !(cause instanceof NotStarted),
      }),
  });

const stopGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGTERM");
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
const CURSOR_FORWARD = new RegExp(`${ESC}\\[(\\d*)C`, "g");

// claude draws the gaps between words of a dialog as cursor moves, so they become spaces before the other controls are dropped.
const withoutEscapes = (text: string) =>
  text
    .replace(CURSOR_FORWARD, (_, count: string) =>
      " ".repeat(Number(count || "1")),
    )
    .replace(CONTROL, "")
    .replace(TITLE_SET, "")
    .replace(/\r/g, "\n");

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

const lastLine = (text: string) => lines(text).at(-1) ?? null;

const questionBefore = (text: string) =>
  lines(text)
    .filter((line) => line.endsWith("?"))
    .at(-1) ?? null;

const VIEW =
  /View:\s*https:\/\/claude\.ai\/code\/((?:session|cse)_[A-Za-z0-9]{8,64})(?=[^A-Za-z0-9])/;
const CREATED = /Created cloud session:\s*([^\n]*)/;
const TRUST_PROMPT = /Is this a project you created or one you trust\?/;
const CONFIRM_PROMPT = /Enter\s*to\s*confirm/;
const OUTPUT_KEPT = 64 * 1024;
const START_TIMEOUT_MS = 90_000;
const KILL_AFTER_MS = 3_000;
