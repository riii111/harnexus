import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import {
  listDirectoryIfExists,
  prepareDirectory,
  readTextFileIfExists,
  removeFile,
  writeFileAtomic,
} from "../../runtime/fs.boundary.ts";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import type { CloudCheckouts } from "./cloud-checkouts.ts";
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
    checkouts,
    configDir = claudeConfigDir(process.env),
  }: { cwd: string; checkouts: CloudCheckouts; configDir?: string },
): Promise<Result<string, CloudCopyFailed>> => {
  const known = checkouts.repositoryOf(cloudSessionId);
  let ran = await teleport(cli, cloudSessionId, known, { cwd, checkouts });
  // A refused teleport writes no copy and runs no model turn, so trying again from the checkout its refusal names costs nothing more.
  const named =
    known === null && ran.isOk() ? repositoryIn(ran.value.refusal) : null;
  if (named !== null) {
    checkouts.remember(cloudSessionId, named);
    ran = await teleport(cli, cloudSessionId, named, { cwd, checkouts });
  }
  if (ran.isErr()) return copyFailed(ran.error.message);
  const { run, refusal, copiedAt } = ran.value;
  const answer = printAnswer(run.stdout);
  const sessionId = answer?.session_id;
  if (
    run.ended !== "exit" ||
    answer === null ||
    answer.is_error === true ||
    typeof sessionId !== "string" ||
    !UUID.test(sessionId)
  ) {
    return copyFailed(
      refusal ??
        firstLine(run.stderr) ??
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
  const stable = await stabilizeCopy(sessionId, copiedAt, configDir);
  if (stable.isErr()) {
    await removeCloudCopy(sessionId, configDir);
    return copyFailed(stable.error.message);
  }
  return Result.ok(sessionId);
};

// In print mode teleport prints nothing when it refuses; the reason is written only to its debug log, which is removed once read.
const teleport = async (
  cli: CloudCli,
  cloudSessionId: string,
  repository: string | null,
  { cwd, checkouts }: { cwd: string; checkouts: CloudCheckouts },
): Promise<
  Result<
    { run: ClaudeRun; refusal: string | null; copiedAt: number },
    { message: string }
  >
> => {
  const logDir = join(cwd, LOG_FOLDER);
  const ready = await prepareDirectory(logDir);
  if (ready.isErr()) return Result.err(ready.error);
  const folder =
    repository === null
      ? Result.ok({ dir: cwd, release: () => {} })
      : await checkouts.take(repository);
  if (folder.isErr()) return Result.err(folder.error);
  const log = join(logDir, `${randomUUID()}.log`);
  const copiedAt = Date.now();
  try {
    const ran = await cli.run(
      cli.file,
      [
        "--teleport",
        cloudSessionId,
        "-p",
        COPY_PROMPT,
        "--output-format",
        "json",
        "--debug-file",
        log,
        // A checkout may hold a branch the Cloud session wrote, so its settings, hooks and MCP servers are never loaded here.
        "--setting-sources",
        "user",
        "--strict-mcp-config",
      ],
      "",
      {
        cwd: folder.value.dir,
        env: cli.env,
        timeoutMs: COPY_TIMEOUT_MS,
        killGraceMs: KILL_GRACE_MS,
      },
    );
    const logged = await readTextFileIfExists(log);
    await removeFile(log);
    if (ran.isErr()) return Result.err(ran.error);
    return Result.ok({
      run: ran.value,
      refusal: logged.isOk() ? refusalIn(logged.value ?? "") : null,
      copiedAt,
    });
  } finally {
    folder.value.release();
  }
};

// A copy whose bridge stopped while it ran leaves its debug log, which holds the session's details, so the logs left over are removed when the bridge starts.
export const sweepCloudLogs = async (copyDir: string) => {
  const logDir = join(copyDir, LOG_FOLDER);
  const names = await listDirectoryIfExists(logDir);
  if (names.isErr() || names.value === null) return;
  for (const name of names.value) {
    if (name.endsWith(".log")) await removeFile(join(logDir, name));
  }
};

const refusalIn = (log: string) => {
  const found = REFUSAL.exec(log)?.[1];
  return found === undefined
    ? null
    : textOf(found.replace(/"$/, "").replaceAll("\\n", " "));
};

const repositoryIn = (refusal: string | null) => {
  const found = refusal === null ? undefined : CHECKOUT_OF.exec(refusal)?.[1];
  if (found === undefined) return null;
  return found.split("/").some((part) => part === "." || part === "..")
    ? null
    : found;
};

class CloudCopyUnstable extends TaggedError("CloudCopyUnstable")<{
  message: string;
}> {}

// Each teleport copy gives the records new uuids, which would change the turn ids, pages and cursors the app holds; a record's uuid is rewritten from when it was written, its kind and its content, so every copy names a record the same way.
// Every occurrence of an old uuid is replaced, so the links between records, such as parentUuid, follow; a record without a time keeps its uuid.
// teleport ends each copy with records of its own, the note that the session goes on here and the /cost command, timed when the copy ran; they are left out, so every copy ends with the Cloud session's last record. A Cloud record written while the copy ran is left out too and comes with the next copy.
export const stabilizeCopy = async (
  copySessionId: string,
  copiedAt: number,
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
  const kept: string[] = [];
  for (const line of text.value.split("\n")) {
    const parsed = parseJson(line);
    const record =
      parsed.isOk() && isObject(parsed.value) ? parsed.value : null;
    if (record !== null && writtenSince(record.timestamp, copiedAt)) continue;
    kept.push(line);
    if (record === null) continue;
    const { uuid, timestamp, type } = record;
    if (typeof uuid !== "string" || !UUID.test(uuid)) continue;
    if (typeof timestamp !== "string" || typeof type !== "string") continue;
    const body = JSON.stringify(
      record.message ?? record.attachment ?? record.subtype ?? null,
    );
    const key = `${type}@${timestamp}#${body}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    renamed.set(uuid, uuidFrom(`${key}#${count}`));
  }
  const stable = kept
    .join("\n")
    .replace(UUID_IN_TEXT, (id) => renamed.get(id) ?? id);
  if (stable === text.value) return Result.ok();
  const written = await writeFileAtomic(found.value, stable);
  return written.isErr()
    ? unstable("the copy of the Cloud session could not be rewritten")
    : Result.ok();
};

const writtenSince = (timestamp: unknown, time: number) =>
  typeof timestamp === "string" && Date.parse(timestamp) >= time;

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

const LOG_FOLDER = "logs";

const REFUSAL = /Teleport in print mode failed: (.*)$/m;

const CHECKOUT_OF = /from a checkout of ([\w.-]+\/[\w.-]+?)\.(?:\s|$)/;

const COPY_RAN_MODEL =
  "copying the Cloud session ran a model turn, so copies of this chat stop until harnexus restarts; run bun run doctor";

const COPY_UNCHECKED =
  "claude --teleport did not say whether copying ran a model turn, so copies of this chat stop until harnexus restarts; run bun run doctor";

const SEND_TIMEOUT_MS = 60_000;

const COPY_TIMEOUT_MS = 120_000;

const KILL_GRACE_MS = 5_000;
