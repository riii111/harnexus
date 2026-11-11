import { join } from "node:path";

import { Result, TaggedError } from "better-result";
import { z } from "zod";

import {
  type FileSyncFailed,
  type FileWriteFailed,
  readTextFileIfExists,
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
  // A hand-over that may have written the main conversation; such a side chat takes no more messages.
  stopped: z.boolean(),
});

const STATE = z.strictObject({
  version: z.literal(1),
  sideChats: z.array(SAVED),
});

export type SideChatStore = {
  all: () => readonly SavedSideChat[];
  save: (saved: SavedSideChat) => Promise<Result<void, SideChatNotSaved>>;
  remove: (threadId: string) => Promise<Result<void, SideChatNotSaved>>;
};

class SideChatStateUnreadable extends TaggedError("SideChatStateUnreadable")<{
  path: string;
  cause?: unknown;
  message: string;
}> {}

class SideChatNotSaved extends TaggedError("SideChatNotSaved")<{
  cause: FileWriteFailed | FileSyncFailed;
  message: string;
}> {}

export const sideChatsPath = (stateDir: string) =>
  join(stateDir, SIDE_CHATS_FILE);

// A missing file holds no side chat; one that cannot be read is an error, so its side chats are never overwritten as if there were none.
export const openSideChatStore = (path: string) =>
  Result.gen(async function* () {
    const text = yield* Result.await(
      readTextFileIfExists(path).then((read) =>
        read.mapError(
          (cause) =>
            new SideChatStateUnreadable({
              path,
              cause,
              message: `cannot read ${path}`,
            }),
        ),
      ),
    );
    if (text === null) {
      return Result.ok(
        createSideChatStore([], (state) => writeFileAtomic(path, state)),
      );
    }

    const parsed = STATE.safeParse(parseJson(text).unwrapOr(undefined));
    if (!parsed.success) {
      return Result.err(
        new SideChatStateUnreadable({
          path,
          message: `${path} does not match the side chat state format`,
        }),
      );
    }

    const ids = new Set(parsed.data.sideChats.map(({ threadId }) => threadId));
    if (ids.size !== parsed.data.sideChats.length) {
      return Result.err(
        new SideChatStateUnreadable({
          path,
          message: `${path} names a side chat more than once`,
        }),
      );
    }

    return Result.ok(
      createSideChatStore(parsed.data.sideChats, (state) =>
        writeFileAtomic(path, state),
      ),
    );
  });

export const unsavedSideChats = () =>
  createSideChatStore([], async () => Result.ok());

const createSideChatStore = (
  initial: readonly SavedSideChat[],
  persist: (
    state: string,
  ) => Promise<Result<void, FileWriteFailed | FileSyncFailed>>,
): SideChatStore => {
  let records: ReadonlyMap<string, SavedSideChat> = new Map(
    initial.map((saved) => [saved.threadId, saved]),
  );
  const queue = createSerialQueue();

  const change = (next: (current: Map<string, SavedSideChat>) => void) =>
    queue.run("side-chats", async () => {
      const updated = new Map(records);
      next(updated);
      // Memory follows the change even when the write fails, so the next write that succeeds also saves this one.
      records = updated;
      const written = await persist(serialize(updated));
      return written.isOk()
        ? Result.ok()
        : Result.err(
            new SideChatNotSaved({
              cause: written.error,
              message: "cannot save the side chats",
            }),
          );
    });

  return {
    all: () => [...records.values()],
    save: (saved) => change((current) => current.set(saved.threadId, saved)),
    remove: (threadId) => change((current) => current.delete(threadId)),
  };
};

const serialize = (records: ReadonlyMap<string, SavedSideChat>) =>
  `${JSON.stringify({ version: 1, sideChats: [...records.values()] }, null, 2)}\n`;

const SIDE_CHATS_FILE = "side-chats.json";
