import { join } from "node:path";

import { Result, TaggedError } from "better-result";
import { z } from "zod";

import {
  listFileNames,
  prepareDirectory,
  readTextFileIfExists,
  removeFile,
  writeFileAtomic,
} from "../lib/fs.boundary.ts";
import { parseJson } from "../lib/json.boundary.ts";
import { createSerialQueue } from "../lib/serial-queue.ts";

// A saved side chat of a Claude thread that no agent has taken a message in yet, with what its first message needs after a restart. point is where the main conversation stood when the side chat opened: null when it held none yet, and "unread" when that could not be read.
export type SavedSideChat = z.infer<typeof SAVED>;

const NAME = z.string().min(1);

const POINT = z.strictObject({
  sessionId: NAME,
  at: NAME,
  model: NAME,
  cwd: NAME,
});

const SAVED = z.strictObject({
  threadId: NAME,
  // The model and directory of the Claude thread the side chat runs as until a message goes to Codex; null for one opened on Codex.
  claude: z.strictObject({ model: NAME, cwd: NAME }).nullable(),
  point: z.union([POINT, z.null(), z.literal("unread")]),
  instructions: z.string().nullable(),
  // The model picked before the first message, if any.
  choice: NAME.nullable(),
  // A hand-over that may have written the main conversation; such a side chat takes no more messages.
  stopped: z.boolean(),
});

export type SideChatStore = {
  // The side chats the folder held when it was opened; one whose file cannot be read is listed as a stopped side chat.
  all: () => readonly SavedSideChat[];
  // False when the folder cannot be listed, so which side chats it held is unknown and none could be saved.
  usable: boolean;
  save: (saved: SavedSideChat) => Promise<Result<void, SideChatNotSaved>>;
  remove: (threadId: string) => Promise<Result<void, SideChatNotSaved>>;
};

export class SideChatStateUnreadable extends TaggedError(
  "SideChatStateUnreadable",
)<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export type NotSavedReason =
  | "FileWriteFailed"
  | "FileSyncFailed"
  | "FileRemoveFailed"
  | "DirectoryPrepareFailed"
  | "SideChatStateUnreadable";

class SideChatNotSaved extends TaggedError("SideChatNotSaved")<{
  reason: NotSavedReason;
  message: string;
}> {}

export const sideChatsPath = (stateDir: string) =>
  join(stateDir, SIDE_CHATS_FOLDER);

// One file per side chat, named by its thread, so a bridge never writes over another's side chats and a file that cannot be read still names its side chat.
export const openSideChatStore = (folder: string) =>
  Result.gen(async function* () {
    const unreadable = (cause: unknown) =>
      new SideChatStateUnreadable({
        path: folder,
        cause,
        message: `cannot read the side chats in ${folder}`,
      });
    yield* Result.await(
      prepareDirectory(folder).then((made) => made.mapError(unreadable)),
    );
    const names = yield* Result.await(
      listFileNames(folder).then((listed) => listed.mapError(unreadable)),
    );
    const read = await Promise.all(
      names.flatMap((name) => {
        const threadId = threadIdOf(name);
        return threadId === null ? [] : [readSideChat(folder, threadId)];
      }),
    );
    return Result.ok(createFileStore(folder, read));
  });

export const unsavedSideChats = (): SideChatStore => {
  const records = new Map<string, SavedSideChat>();
  const change = async (
    apply: (current: Map<string, SavedSideChat>) => void,
  ) => {
    apply(records);
    return Result.ok();
  };

  return {
    all: () => [...records.values()],
    usable: true,
    save: (saved) => change((current) => current.set(saved.threadId, saved)),
    remove: (threadId) => change((current) => current.delete(threadId)),
  };
};

// Stands in for a folder that cannot be listed: which side chats it held is unknown, and none is saved.
export const unreadableSideChats = (): SideChatStore => ({
  all: () => [],
  usable: false,
  save: async () => Result.err(notSaved("SideChatStateUnreadable")),
  remove: async () => Result.err(notSaved("SideChatStateUnreadable")),
});

const createFileStore = (
  folder: string,
  initial: readonly SavedSideChat[],
): SideChatStore => {
  const records = new Map(initial.map((saved) => [saved.threadId, saved]));
  const queue = createSerialQueue();

  return {
    all: () => [...records.values()],
    usable: true,
    save: (saved) =>
      queue.run(saved.threadId, async () => {
        const made = await prepareDirectory(folder);
        if (made.isErr()) return Result.err(notSaved(made.error._tag));
        const written = await writeFileAtomic(
          fileOf(folder, saved.threadId),
          `${JSON.stringify(saved, null, 2)}\n`,
        );
        if (written.isErr()) return Result.err(notSaved(written.error._tag));
        records.set(saved.threadId, saved);
        return Result.ok();
      }),
    remove: (threadId) =>
      queue.run(threadId, async () => {
        const removed = await removeFile(fileOf(folder, threadId));
        if (removed.isErr()) return Result.err(notSaved(removed.error._tag));
        records.delete(threadId);
        return Result.ok();
      }),
  };
};

const readSideChat = async (
  folder: string,
  threadId: string,
): Promise<SavedSideChat> => {
  const text = await readTextFileIfExists(fileOf(folder, threadId));
  const parsed = SAVED.safeParse(
    text.isOk() && text.value !== null
      ? parseJson(text.value).unwrapOr(undefined)
      : undefined,
  );
  // A file that cannot be read still names its thread, so that side chat takes no message instead of running without what it was to hand over.
  return parsed.success && parsed.data.threadId === threadId
    ? parsed.data
    : {
        threadId,
        claude: null,
        point: "unread",
        instructions: null,
        choice: null,
        stopped: true,
      };
};

const fileOf = (folder: string, threadId: string) =>
  join(folder, `${Buffer.from(threadId, "utf8").toString("hex")}${SUFFIX}`);

const threadIdOf = (name: string) => {
  const hex = name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : "";
  // Other files, such as a write's leftovers, are ignored.
  return /^(?:[0-9a-f]{2})+$/.test(hex)
    ? Buffer.from(hex, "hex").toString("utf8")
    : null;
};

const notSaved = (reason: NotSavedReason) =>
  new SideChatNotSaved({
    reason,
    message: `cannot save the side chats: ${reason}`,
  });

const SIDE_CHATS_FOLDER = "side-chats";

const SUFFIX = ".json";
