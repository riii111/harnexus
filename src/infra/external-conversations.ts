import { join } from "node:path";

import { Result, TaggedError } from "better-result";
import { z } from "zod";

import {
  listDirectoryIfExists,
  prepareDirectory,
  readTextFileIfExists,
  writeFileAtomic,
  writeFileExclusive,
} from "../lib/fs.boundary.ts";
import { parseJson } from "../lib/json.boundary.ts";

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

class ExternalConversationsContended extends TaggedError(
  "ExternalConversationsContended",
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

// The state is a folder of numbered revisions, each external-conversations.json as it stood after one change; a change is made by creating the next number, which only one bridge can do, so a bridge working from an older revision never writes over a newer one.
const REVISION = /^(\d{12})\.json$/;

const revisionName = (revision: number) =>
  `${String(revision).padStart(12, "0")}.json`;

// A missing folder holds nothing; a latest revision that cannot be read is an error, so its intents are never taken for none.
export const readExternalConversations = async (
  dir: string,
): Promise<
  Result<
    { revision: number; state: ExternalConversationState },
    ExternalConversationsUnreadable
  >
> => {
  for (let tries = 0; tries < READ_TRIES; tries++) {
    const names = await listDirectoryIfExists(dir);
    if (names.isErr())
      return Result.err(
        new ExternalConversationsUnreadable({
          path: dir,
          message: names.error.message,
        }),
      );
    const latest = Math.max(
      0,
      ...(names.value ?? []).flatMap((name) => {
        const matched = REVISION.exec(name)?.[1];
        return matched === undefined ? [] : [Number(matched)];
      }),
    );
    if (latest === 0)
      return Result.ok({ revision: 0, state: EMPTY_EXTERNAL_STATE });
    const path = join(dir, revisionName(latest));
    const read = await readTextFileIfExists(path);
    if (read.isErr())
      return Result.err(
        new ExternalConversationsUnreadable({
          path,
          message: read.error.message,
        }),
      );
    // Emptied or gone after the folder was listed, so a newer revision stands; it is listed again.
    if (read.value === null || read.value === "") continue;
    const parsed = STATE.safeParse(parseJson(read.value).unwrapOr(undefined));
    return parsed.success
      ? Result.ok({
          revision: latest,
          state: {
            bindings: parsed.data.bindings,
            intents: parsed.data.intents,
          },
        })
      : Result.err(
          new ExternalConversationsUnreadable({
            path,
            message: `${path} is not a version ${FILE_VERSION} file of chat bindings`,
          }),
        );
  }

  return Result.err(
    new ExternalConversationsUnreadable({
      path: dir,
      message: `${dir} kept changing while it was read`,
    }),
  );
};

// Changes the state as it stands now; when another bridge made a revision first, the change is made again on that one.
export const updateExternalConversations = async <T>(
  dir: string,
  change: (state: ExternalConversationState) => {
    // Null leaves the state as it is.
    state: ExternalConversationState | null;
    result: T;
  },
) => {
  const made = await prepareDirectory(dir);
  if (made.isErr()) return Result.err(made.error);
  for (let tries = 0; tries < UPDATE_TRIES; tries++) {
    const read = await readExternalConversations(dir);
    if (read.isErr()) return Result.err(read.error);
    const changed = change(read.value.state);
    if (changed.state === null)
      return Result.ok({ state: read.value.state, result: changed.result });
    const next = read.value.revision + 1;
    const created = await writeFileExclusive(
      join(dir, revisionName(next)),
      JSON.stringify({ version: FILE_VERSION, ...changed.state }),
    );
    if (created.isErr()) return Result.err(created.error);
    if (!created.value) continue;
    await prune(dir, next);
    return Result.ok({ state: changed.state, result: changed.result });
  }

  return Result.err(
    new ExternalConversationsContended({
      path: dir,
      message: `${dir} was changed by other bridges on every try`,
    }),
  );
};

// An older revision is emptied rather than removed, so its number stays taken and a bridge that worked from an older revision can never create it again and have its change passed over.
const prune = async (dir: string, latest: number) => {
  const until = Math.max(0, latest - KEPT_REVISIONS - PRUNE_BATCH);
  for (let revision = latest - KEPT_REVISIONS; revision > until; revision--) {
    const emptied = await writeFileAtomic(
      join(dir, revisionName(revision)),
      "",
    );
    if (emptied.isErr()) return;
  }
};

const READ_TRIES = 5;
const UPDATE_TRIES = 20;
const KEPT_REVISIONS = 8;
const PRUNE_BATCH = 8;
