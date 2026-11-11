import { join } from "node:path";

import { Result, TaggedError } from "better-result";
import { z } from "zod";

import { readTextFileIfExists, writeFileAtomic } from "../lib/fs.boundary.ts";
import { parseJson } from "../lib/json.boundary.ts";
import { createSerialQueue } from "../lib/serial-queue.ts";
import { acquireLock } from "./state-locks.ts";

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

const STATE = z.strictObject({
  version: z.literal(1),
  sideChats: z.array(SAVED),
});

export type SideChatStore = {
  // The side chats the file held when it was opened.
  all: () => readonly SavedSideChat[];
  // False when the file cannot be read, so nothing could be restored from a side chat opened now.
  writable: boolean;
  save: (saved: SavedSideChat) => Promise<Result<void, SideChatNotSaved>>;
  remove: (threadId: string) => Promise<Result<void, SideChatNotSaved>>;
};

export class SideChatStateUnreadable extends TaggedError(
  "SideChatStateUnreadable",
)<{
  path: string;
  // Thread ids still readable from the damaged text, whose side chats can no longer be restored.
  threadIds: readonly string[];
  cause?: unknown;
  message: string;
}> {}

export type NotSavedReason =
  | "FileWriteFailed"
  | "FileSyncFailed"
  | "SideChatStateUnreadable"
  | "StateLockBusy"
  | "StateLockFailed";

class SideChatNotSaved extends TaggedError("SideChatNotSaved")<{
  reason: NotSavedReason;
  message: string;
}> {}

export const sideChatsPath = (stateDir: string) =>
  join(stateDir, SIDE_CHATS_FILE);

// A missing file holds no side chat; one that cannot be read is an error, so its side chats are never overwritten as if there were none.
export const openSideChatStore = (path: string) =>
  readSideChats(path).then((read) =>
    read.map((records) => createFileStore(path, records)),
  );

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
    writable: true,
    save: (saved) => change((current) => current.set(saved.threadId, saved)),
    remove: (threadId) => change((current) => current.delete(threadId)),
  };
};

// Stands in for a file that cannot be read: each side chat still named in it takes no more messages, and none is saved.
export const unreadableSideChats = (
  threadIds: readonly string[],
): SideChatStore => ({
  all: () =>
    threadIds.map((threadId) => ({
      threadId,
      claude: null,
      point: "unread",
      instructions: null,
      choice: null,
      stopped: true,
    })),
  writable: false,
  save: async () => Result.err(notSaved("SideChatStateUnreadable")),
  remove: async () => Result.err(notSaved("SideChatStateUnreadable")),
});

const createFileStore = (
  path: string,
  initial: ReadonlyMap<string, SavedSideChat>,
): SideChatStore => {
  let records = initial;
  const queue = createSerialQueue();

  // Each change is made on the file as it stands under its lock, so bridges sharing the file never write over each other's side chats.
  const change = (apply: (current: Map<string, SavedSideChat>) => void) =>
    queue.run(path, async () => {
      const locked = await acquireLock(`${path}.lock`, LOCK_WAIT_MS);
      if (locked.isErr()) return Result.err(notSaved(locked.error._tag));
      try {
        const read = await readSideChats(path);
        if (read.isErr()) return Result.err(notSaved(read.error._tag));
        const next = new Map(read.value);
        apply(next);
        const written = await writeFileAtomic(path, serialize(next));
        if (written.isErr()) return Result.err(notSaved(written.error._tag));
        records = next;
        return Result.ok();
      } finally {
        await locked.value.release();
      }
    });

  return {
    all: () => [...records.values()],
    writable: true,
    save: (saved) => change((current) => current.set(saved.threadId, saved)),
    remove: (threadId) => change((current) => current.delete(threadId)),
  };
};

const readSideChats = async (
  path: string,
): Promise<Result<Map<string, SavedSideChat>, SideChatStateUnreadable>> => {
  const text = await readTextFileIfExists(path);
  if (text.isErr()) {
    return Result.err(
      new SideChatStateUnreadable({
        path,
        threadIds: [],
        cause: text.error,
        message: `cannot read ${path}`,
      }),
    );
  }

  if (text.value === null) {
    return Result.ok(new Map<string, SavedSideChat>());
  }

  const parsed = STATE.safeParse(parseJson(text.value).unwrapOr(undefined));
  const ids = parsed.success
    ? parsed.data.sideChats.map(({ threadId }) => threadId)
    : [];
  if (!parsed.success || new Set(ids).size !== ids.length) {
    return Result.err(
      new SideChatStateUnreadable({
        path,
        threadIds: salvagedThreadIds(text.value),
        message: `${path} does not match the side chat state format`,
      }),
    );
  }

  return Result.ok(
    new Map(parsed.data.sideChats.map((saved) => [saved.threadId, saved])),
  );
};

const salvagedThreadIds = (text: string) => [
  ...new Set(
    [...text.matchAll(/"threadId"\s*:\s*"([^"\\]+)"/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  ),
];

const notSaved = (reason: NotSavedReason) =>
  new SideChatNotSaved({
    reason,
    message: `cannot save the side chats: ${reason}`,
  });

const serialize = (records: ReadonlyMap<string, SavedSideChat>) =>
  `${JSON.stringify({ version: 1, sideChats: [...records.values()] }, null, 2)}\n`;

const SIDE_CHATS_FILE = "side-chats.json";

const LOCK_WAIT_MS = 2_000;
