import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import { readTextFileIfExists } from "../../runtime/fs.boundary.ts";
import { isObject } from "../../runtime/object.ts";

class AutomationUnparsable extends TaggedError("AutomationUnparsable")<{
  message: string;
  cause: unknown;
}> {}

// The app's automation_update answers never say whose thread an automation wakes, so the file the app saves for it is the only record; null when it is missing or wakes no thread.
export const readAutomationThread = async (codexHome: string, id: string) => {
  const path = join(codexHome, "automations", id, "automation.toml");
  const read = await readTextFileIfExists(path);
  if (read.isErr()) return read;
  const text = read.value;
  if (text === null) return Result.ok(null);
  return Result.try({
    try: () => Bun.TOML.parse(text),
    catch: (cause) =>
      new AutomationUnparsable({ message: `cannot parse ${path}`, cause }),
  }).map((parsed) =>
    isObject(parsed) && typeof parsed.target_thread_id === "string"
      ? parsed.target_thread_id
      : null,
  );
};
