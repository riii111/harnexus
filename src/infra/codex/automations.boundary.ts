import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import {
  listDirectoryIfExists,
  readTextFileIfExists,
  writeFileAtomic,
} from "../../runtime/fs.boundary.ts";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";
import { createSerialQueue } from "../../runtime/serial-queue.ts";

class AutomationUnparsable extends TaggedError("AutomationUnparsable")<{
  message: string;
  cause: unknown;
}> {}

class CronRecordCorrupt extends TaggedError("CronRecordCorrupt")<{
  path: string;
  message: string;
}> {}

type SavedAutomation = {
  kind: string | null;
  targetThreadId: string | null;
  name: string | null;
  prompt: string | null;
};

// The app's automation_update answers never say whose thread an automation wakes, so the file the app saves for it is the only record; null when it is missing.
export const readAutomation = (codexHome: string, id: string) => {
  const path = join(codexHome, "automations", id, "automation.toml");
  return Result.gen(async function* () {
    const text = yield* Result.await(readTextFileIfExists(path));
    if (text === null) return Result.ok<SavedAutomation | null>(null);
    const parsed = yield* Result.try({
      try: () => Bun.TOML.parse(text),
      catch: (cause) =>
        new AutomationUnparsable({ message: `cannot parse ${path}`, cause }),
    });
    return Result.ok<SavedAutomation | null>({
      kind: stringField(parsed, "kind"),
      targetThreadId: stringField(parsed, "target_thread_id"),
      name: stringField(parsed, "name"),
      prompt: stringField(parsed, "prompt"),
    });
  });
};

export const listAutomationIds = async (codexHome: string) =>
  (await listDirectoryIfExists(join(codexHome, "automations"))).map(
    (names) => names ?? [],
  );

const stringField = (parsed: unknown, key: string) =>
  isObject(parsed) && typeof parsed[key] === "string" ? parsed[key] : null;

export type CronRecord = ReturnType<typeof openCronRecord>;

// The ids of the cron automations Claude threads created through the bridge, kept beside the thread store; a cron run starts a new thread each time, so the record belongs to no single thread.
export const openCronRecord = (path: string) => {
  const queue = createSerialQueue();

  const read = () =>
    Result.gen(async function* () {
      const text = yield* Result.await(readTextFileIfExists(path));
      if (text === null) return Result.ok<string[]>([]);
      const parsed = parseJson(text);
      const ids =
        parsed.isOk() &&
        isObject(parsed.value) &&
        parsed.value.version === CRON_RECORD_VERSION &&
        Array.isArray(parsed.value.ids) &&
        parsed.value.ids.every((id) => typeof id === "string")
          ? (parsed.value.ids as string[])
          : null;
      return ids === null
        ? Result.err(
            new CronRecordCorrupt({
              path,
              message: `${path} does not match the cron record format`,
            }),
          )
        : Result.ok(ids);
    });

  const change = (next: (ids: string[]) => string[]) =>
    queue.run(path, () =>
      Result.gen(async function* () {
        const ids = yield* Result.await(read());
        yield* Result.await(
          writeFileAtomic(
            path,
            `${JSON.stringify({ version: CRON_RECORD_VERSION, ids: next(ids) }, null, 2)}\n`,
          ),
        );
        return Result.ok();
      }),
    );

  return {
    has: async (id: string) => (await read()).map((ids) => ids.includes(id)),
    add: (id: string) =>
      change((ids) => (ids.includes(id) ? ids : [...ids, id])),
    remove: (id: string) => change((ids) => ids.filter((kept) => kept !== id)),
  };
};

export const cronRecordPath = (statePath: string) =>
  `${statePath}.cron-automations.json`;

const CRON_RECORD_VERSION = 1;
