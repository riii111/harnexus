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

export type ConnectionSettings = {
  // Skills that mean /cloud when picked in a chat that holds nothing yet.
  cloudSkills: readonly string[];
};

const DEFAULT_SETTINGS: ConnectionSettings = { cloudSkills: [] };

const SETTINGS = z.object({
  cloudSkills: z.array(z.string().regex(/^[A-Za-z0-9._:-]+$/)).default([]),
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
    ? Result.ok({ cloudSkills: parsed.data.cloudSkills })
    : Result.err(
        new ConnectionSettingsInvalid({
          path,
          message: `${path} must be a JSON object whose cloudSkills is a list of skill names`,
        }),
      );
};
