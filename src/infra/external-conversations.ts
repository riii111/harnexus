import { dirname } from "node:path";

import { Result, TaggedError } from "better-result";
import { z } from "zod";

import {
  prepareDirectory,
  readTextFileIfExists,
  writeFileAtomic,
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
