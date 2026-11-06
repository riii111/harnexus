import { dirname } from "node:path";

import { Result, TaggedError } from "better-result";
import { z } from "zod";

import {
  prepareDirectory,
  readTextFileIfExists,
  removeFile,
  writeFileAtomic,
  writeFileExclusive,
} from "../lib/fs.boundary.ts";
import { parseJson } from "../lib/json.boundary.ts";
import { isObject } from "../lib/object.ts";
import { processAlive } from "../lib/run.boundary.ts";

// A chat that shows an adapter's conversation, as the adapter declared it or as its first turn confirmed it.
export type ConversationBinding = {
  adapterId: string;
  conversationId: string;
  threadId: string;
};

// A chat asked of the app for an adapter's conversation whose first turn has not been seen; kept until that turn or a certain failure settles it.
export type CreateIntent = {
  intentId: string;
  adapterId: string;
  conversationId: string;
  callerThreadId: string;
  createdAt: string;
};

export type ExternalConversationState = {
  bindings: readonly ConversationBinding[];
  intents: readonly CreateIntent[];
};

class ExternalConversationsUnreadable extends TaggedError(
  "ExternalConversationsUnreadable",
)<{ path: string; message: string }> {}

const FILE_VERSION = 1;

const STATE = z.strictObject({
  version: z.literal(FILE_VERSION),
  bindings: z.array(
    z.strictObject({
      adapterId: z.string().min(1),
      conversationId: z.string().min(1),
      threadId: z.string().min(1),
    }),
  ),
  intents: z.array(
    z.strictObject({
      intentId: z.string().min(1),
      adapterId: z.string().min(1),
      conversationId: z.string().min(1),
      callerThreadId: z.string().min(1),
      createdAt: z.string(),
    }),
  ),
});

export const EMPTY_EXTERNAL_STATE: ExternalConversationState = {
  bindings: [],
  intents: [],
};

// A missing file holds nothing; a file that cannot be read is an error, so its intents are never taken for none.
export const readExternalConversations = async (
  path: string,
): Promise<
  Result<ExternalConversationState, ExternalConversationsUnreadable>
> => {
  const read = await readTextFileIfExists(path);
  if (read.isErr())
    return Result.err(
      new ExternalConversationsUnreadable({
        path,
        message: read.error.message,
      }),
    );
  if (read.value === null) return Result.ok(EMPTY_EXTERNAL_STATE);
  const parsed = STATE.safeParse(parseJson(read.value).unwrapOr(undefined));
  return parsed.success
    ? Result.ok({
        bindings: parsed.data.bindings,
        intents: parsed.data.intents,
      })
    : Result.err(
        new ExternalConversationsUnreadable({
          path,
          message: `${path} is not a version ${FILE_VERSION} file of chat bindings`,
        }),
      );
};

class ExternalConversationsLocked extends TaggedError(
  "ExternalConversationsLocked",
)<{ path: string; message: string }> {}

// Changes the file as it stands now, under a lock every bridge sharing it takes, so no bridge's change is written over by another's older copy; answers the state the file then holds.
export const updateExternalConversations = async <T>(
  path: string,
  change: (state: ExternalConversationState) => {
    // Null leaves the file as it is.
    state: ExternalConversationState | null;
    result: T;
  },
  { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {},
) => {
  const lock = `${path}.lock`;
  const made = await prepareDirectory(dirname(path));
  if (made.isErr()) return Result.err(made.error);
  const held = await takeLock(lock, waitMs, staleMs);
  if (held.isErr()) return Result.err(held.error);
  const read = await readExternalConversations(path);
  const changed = read.map(change);
  const written =
    changed.isOk() && changed.value.state !== null
      ? await writeExternalConversations(path, changed.value.state)
      : Result.ok();
  await removeFile(lock);
  if (changed.isErr()) return Result.err(changed.error);
  if (written.isErr()) return Result.err(written.error);
  return Result.ok({
    state: changed.value.state ?? read.unwrapOr(EMPTY_EXTERNAL_STATE),
    result: changed.value.result,
  });
};

// A lock left by a bridge that died, or held far longer than any change takes, is taken over.
const takeLock = async (lock: string, waitMs: number, staleMs: number) => {
  const until = Date.now() + waitMs;
  for (;;) {
    const made = await writeFileExclusive(
      lock,
      JSON.stringify({ pid: process.pid, at: Date.now() }),
    );
    if (made.isErr()) return Result.err(made.error);
    if (made.value) return Result.ok();
    const seen = (await readTextFileIfExists(lock)).unwrapOr(null) ?? "";
    const holder = parseJson(seen).unwrapOr(null);
    const stale =
      !isObject(holder) ||
      typeof holder.pid !== "number" ||
      typeof holder.at !== "number" ||
      !processAlive(holder.pid) ||
      Date.now() - holder.at > staleMs;
    // Removed only while it is still the lock read, so a lock another bridge took over meanwhile stays.
    if (stale) {
      const again = (await readTextFileIfExists(lock)).unwrapOr(null) ?? "";
      if (again === seen) await removeFile(lock);
      continue;
    }

    if (Date.now() >= until)
      return Result.err(
        new ExternalConversationsLocked({
          path: lock,
          message: `${lock} is held by another bridge`,
        }),
      );
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
};

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 20;

export const writeExternalConversations = async (
  path: string,
  state: ExternalConversationState,
) => {
  const made = await prepareDirectory(dirname(path));
  if (made.isErr()) return made;
  return writeFileAtomic(
    path,
    JSON.stringify({ version: FILE_VERSION, ...state }),
  );
};
