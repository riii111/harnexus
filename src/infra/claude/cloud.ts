import { createHash } from "node:crypto";
import { Result, TaggedError } from "better-result";
import {
  prepareDirectory,
  readTextFileIfExists,
  removeFile,
  writeFileAtomic,
} from "../../runtime/fs.boundary.ts";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import { printAnswer, UUID } from "./print.ts";
import { bundledClaude, type ClaudeRun, runClaude } from "./run.boundary.ts";
import { claudeConfigDir, findSessionFile } from "./transcripts.ts";

// A Cloud session is named by claude.ai as session_… or cse_…, and its page URL ends in that id.
const CLOUD_SESSION = /^(?:session|cse)_[A-Za-z0-9]{8,64}$/;
const CLOUD_URL =
  /^(?:https?:\/\/)?claude\.ai\/code\/((?:session|cse)_[A-Za-z0-9]{8,64})(?:[/?#].*)?$/;

export const parseCloudSessionId = (text: string): string | null => {
  const trimmed = text.trim();
  if (CLOUD_SESSION.test(trimmed)) return trimmed;
  return CLOUD_URL.exec(trimmed)?.[1] ?? null;
};

export type RunClaude = typeof runClaude;

export type CloudCli = {
  file: string;
  env: Record<string, string | undefined>;
  run: RunClaude;
};

// The SDK's own claude is used by default, since it already holds the sign-in the bridge runs with; a claude installed elsewhere may stop to ask macOS for keychain access when the app starts it. HARNEXUS_CLAUDE_CLI names another one.
export const claudeCliFile = (
  env: Record<string, string | undefined>,
  bundled: () => string | null = bundledClaude,
) => env.HARNEXUS_CLAUDE_CLI || bundled() || "claude";

export const cloudCli = (
  env: Record<string, string | undefined>,
): CloudCli => ({
  file: claudeCliFile(env),
  env,
  run: runClaude,
});

// sent: the session queued the message; rejected: it never reached the session; unknown: it may have, so it is not sent again.
export type CloudSend =
  | { kind: "sent" }
  | { kind: "rejected"; message: string }
  | { kind: "unknown"; message: string };

// The message goes in through stdin, so it never shows in the process list; the CLI exits once the session has queued it, without waiting for a reply.
export const sendToCloud = async (
  cli: CloudCli,
  cloudSessionId: string,
  text: string,
  cwd: string,
): Promise<CloudSend> => {
  const ran = await cli.run(
    cli.file,
    ["-p", "--cloud", cloudSessionId, "--output-format", "json"],
    text,
    {
      cwd,
      env: cli.env,
      timeoutMs: SEND_TIMEOUT_MS,
      killGraceMs: KILL_GRACE_MS,
    },
  );
  if (ran.isErr()) {
    return ran.error.started
      ? { kind: "unknown", message: ran.error.message }
      : { kind: "rejected", message: ran.error.message };
  }
  return sendOutcome(ran.value);
};

const sendOutcome = (run: ClaudeRun): CloudSend => {
  if (run.ended !== "exit") {
    return { kind: "unknown", message: `claude --cloud ended by ${run.ended}` };
  }
  const answer = printAnswer(run.stdout);
  if (answer !== null && answer.ok === true) return { kind: "sent" };
  if (answer !== null && answer.ok === false) {
    return {
      kind: "rejected",
      message: textOf(answer.error) ?? "the Cloud session refused the message",
    };
  }
  // A configuration error, such as a disabled organization policy, is printed to stderr without JSON before anything is sent.
  if (run.status !== 0 && run.stdout.trim() === "") {
    return {
      kind: "rejected",
      message: firstLine(run.stderr) ?? `claude exited with ${run.status}`,
    };
  }
  return {
    kind: "unknown",
    message: "claude --cloud answered without a result",
  };
};

// stopped: the copy may have run a model turn, or did not say how many it ran, so the chat must not be copied again.
class CloudCopyFailed extends TaggedError("CloudCopyFailed")<{
  stopped: "ran_model" | "unchecked" | null;
  message: string;
}> {}

const copyFailed = (
  message: string,
  stopped: CloudCopyFailed["stopped"] = null,
) => Result.err(new CloudCopyFailed({ stopped, message }));

// teleport writes a new local record of the Cloud conversation each time, in cwd's project folder; /cost is answered by the CLI itself, so no model turn runs and nothing reaches the Cloud session.
// The copy is returned with its uuids made stable, and removed when it cannot be.
export const copyCloudSession = async (
  cli: CloudCli,
  cloudSessionId: string,
  {
    cwd,
    configDir = claudeConfigDir(process.env),
  }: { cwd: string; configDir?: string },
): Promise<Result<string, CloudCopyFailed>> => {
  const ready = await prepareDirectory(cwd);
  if (ready.isErr()) return copyFailed(ready.error.message);
  const ran = await cli.run(
    cli.file,
    [
      "--teleport",
      cloudSessionId,
      "-p",
      COPY_PROMPT,
      "--output-format",
      "json",
    ],
    "",
    {
      cwd,
      env: cli.env,
      timeoutMs: COPY_TIMEOUT_MS,
      killGraceMs: KILL_GRACE_MS,
    },
  );
  if (ran.isErr()) return copyFailed(ran.error.message);
  const answer = printAnswer(ran.value.stdout);
  const sessionId = answer?.session_id;
  if (
    ran.value.ended !== "exit" ||
    answer === null ||
    answer.is_error === true ||
    typeof sessionId !== "string" ||
    !UUID.test(sessionId)
  ) {
    return copyFailed(
      firstLine(ran.value.stderr) ??
        textOf(answer?.result) ??
        "claude --teleport answered without a copy",
    );
  }
  const turns = answer.num_turns;
  if (turns !== 0) {
    await removeCloudCopy(sessionId, configDir);
    return typeof turns === "number"
      ? copyFailed(COPY_RAN_MODEL, "ran_model")
      : copyFailed(COPY_UNCHECKED, "unchecked");
  }
  const stable = await stabilizeCopy(sessionId, configDir);
  if (stable.isErr()) {
    await removeCloudCopy(sessionId, configDir);
    return copyFailed(stable.error.message);
  }
  return Result.ok(sessionId);
};

class CloudCopyUnstable extends TaggedError("CloudCopyUnstable")<{
  message: string;
}> {}

// Each teleport copy gives the records new uuids, which would change the turn ids, pages and cursors the app holds; a record's uuid is rewritten from when it was written, its kind and its content, so every copy names a record the same way.
// Every occurrence of an old uuid is replaced, so the links between records, such as parentUuid, follow; a record without a time keeps its uuid.
export const stabilizeCopy = async (
  copySessionId: string,
  configDir: string = claudeConfigDir(process.env),
): Promise<Result<void, CloudCopyUnstable>> => {
  const unstable = (message: string) =>
    Result.err(new CloudCopyUnstable({ message }));
  const found = await findSessionFile(copySessionId, configDir);
  if (found.isErr() || found.value === null) {
    return unstable("the copy of the Cloud session was not found");
  }
  const text = await readTextFileIfExists(found.value);
  if (text.isErr() || text.value === null) {
    return unstable("the copy of the Cloud session could not be read");
  }
  const renamed = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const line of text.value.split("\n")) {
    const parsed = parseJson(line);
    if (parsed.isErr() || !isObject(parsed.value)) continue;
    const { uuid, timestamp, type } = parsed.value;
    if (typeof uuid !== "string" || !UUID.test(uuid)) continue;
    if (typeof timestamp !== "string" || typeof type !== "string") continue;
    const body = JSON.stringify(
      parsed.value.message ??
        parsed.value.attachment ??
        parsed.value.subtype ??
        null,
    );
    const key = `${type}@${timestamp}#${body}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    renamed.set(uuid, uuidFrom(`${key}#${count}`));
  }
  const stable = text.value.replace(
    UUID_IN_TEXT,
    (id) => renamed.get(id) ?? id,
  );
  if (stable === text.value) return Result.ok();
  const written = await writeFileAtomic(found.value, stable);
  return written.isErr()
    ? unstable("the copy of the Cloud session could not be rewritten")
    : Result.ok();
};

const UUID_IN_TEXT = new RegExp(UUID.source.slice(1, -1), "g");

// A version 8 uuid made from a digest of the text.
const uuidFrom = (text: string) => {
  const hex = createHash("sha256").update(text).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

// A copy the thread no longer reads is removed; one that cannot be found or removed is left, since it holds nothing the thread needs.
export const removeCloudCopy = async (
  copySessionId: string,
  configDir: string = claudeConfigDir(process.env),
) => {
  const found = await findSessionFile(copySessionId, configDir);
  if (found.isErr() || found.value === null) return;
  await removeFile(found.value);
};

const textOf = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const firstLine = (text: string) =>
  textOf(
    text
      .trim()
      .split("\n")[0]
      ?.replace(/^Error:\s*/, ""),
  );

const COPY_PROMPT = "/cost";

const COPY_RAN_MODEL =
  "copying the Cloud session ran a model turn, so copies of this chat stop until harnexus restarts; run bun run doctor";

const COPY_UNCHECKED =
  "claude --teleport did not say whether copying ran a model turn, so copies of this chat stop until harnexus restarts; run bun run doctor";

const SEND_TIMEOUT_MS = 60_000;

const COPY_TIMEOUT_MS = 120_000;

const KILL_GRACE_MS = 5_000;
