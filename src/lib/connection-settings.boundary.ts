import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { Result, TaggedError } from "better-result";
import { z } from "zod";

import { readRegularTextFile } from "./fs.boundary.ts";
import { parseJson } from "./json.boundary.ts";
import { isObject } from "./object.ts";

class ConnectionSettingsInvalid extends TaggedError(
  "ConnectionSettingsInvalid",
)<{ path: string; message: string }> {}

// A process the user registered to show and answer outside conversations in chats; observe only reads Cloud sessions, write may also make and answer chats.
export type AdapterSettings = {
  id: string;
  command: string;
  args: readonly string[];
  mode: "observe" | "write";
};

export type ConnectionSettings = {
  // Skills that mean /cloud when picked in a chat that holds nothing yet.
  cloudSkills: readonly string[];
  // Never found by the bridge itself, so without this entry no process is started.
  externalConversationAdapter: AdapterSettings | null;
};

const DEFAULT_SETTINGS: ConnectionSettings = {
  cloudSkills: [],
  externalConversationAdapter: null,
};

const ADAPTER = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  // Only an absolute path, so the program run never depends on the folder the bridge starts in.
  command: z.string().refine(isAbsolute),
  args: z.array(z.string()).default([]),
  mode: z.enum(["observe", "write"]),
});

const SETTINGS = z.object({
  cloudSkills: z.array(z.string().regex(/^[A-Za-z0-9._:-]+$/)).default([]),
  externalConversationAdapter: ADAPTER.nullable().default(null),
});

export const connectionSettingsPath = (
  env: Record<string, string | undefined>,
  home: () => string = homedir,
) => {
  const config = env.XDG_CONFIG_HOME;
  // A relative directory is ignored, as the XDG spec has it.
  const base =
    config !== undefined && isAbsolute(config)
      ? config
      : join(home(), ".config");
  return join(base, "harnexus", "connection.json");
};

// Read once when the bridge starts; a missing file is the default, and an unreadable one is an error the bridge logs before using the default.
export const loadConnectionSettings = async (
  env: Record<string, string | undefined>,
  home: () => string = homedir,
): Promise<Result<ConnectionSettings, ConnectionSettingsInvalid>> => {
  const path = connectionSettingsPath(env, home);
  const read = await readRegularTextFile(path);
  if (read.isErr()) {
    const { cause } = read.error;
    return isObject(cause) && cause.code === "ENOENT"
      ? Result.ok(DEFAULT_SETTINGS)
      : Result.err(
          new ConnectionSettingsInvalid({ path, message: read.error.message }),
        );
  }

  const parsed = SETTINGS.safeParse(parseJson(read.value).unwrapOr(undefined));
  return parsed.success
    ? Result.ok({
        cloudSkills: parsed.data.cloudSkills,
        externalConversationAdapter: parsed.data.externalConversationAdapter,
      })
    : Result.err(
        new ConnectionSettingsInvalid({
          path,
          message: `${path} must be a JSON object whose cloudSkills is a list of skill names and whose externalConversationAdapter, if set, names an id, an absolute command, its args and a mode of observe or write`,
        }),
      );
};
