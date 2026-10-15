import { homedir } from "node:os";
import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import {
  prepareDirectory,
  readTextFileIfExists,
  removeFile,
  writeFileAtomic,
} from "../runtime/fs.boundary.ts";
import { readCommandOutput, runCommand } from "../runtime/process.boundary.ts";
import {
  AGENT_LABEL,
  environmentCommands,
  launchAgent,
} from "./launchd-plan.ts";
import { REGISTERED_ENV_NAMES } from "./open-app-plan.ts";

class LaunchdReadFailed extends TaggedError("LaunchdReadFailed")<{
  message: string;
}> {}

export const configureLaunchd = (
  env: Record<string, string>,
  standard: boolean,
) =>
  Result.gen(async function* () {
    // An already loaded one-shot job must not restore old values after --standard.
    const target = `gui/${process.getuid?.()}/${AGENT_LABEL}`;
    const loaded = yield* Result.await(
      runCommand("/bin/launchctl", ["print", target], process.env),
    );
    if (loaded.status === 0)
      yield* Result.await(
        readCommandOutput("/bin/launchctl", ["bootout", target]),
      );
    if (standard) {
      const existing = yield* Result.await(readTextFileIfExists(agentPath()));
      if (existing !== null) yield* Result.await(removeFile(agentPath()));
    } else {
      yield* Result.await(prepareDirectory(agentDirectory()));
      yield* Result.await(writeFileAtomic(agentPath(), launchAgent(env)));
    }
    for (const args of environmentCommands(standard ? {} : env)) {
      yield* Result.await(readCommandOutput("/bin/launchctl", args));
    }
    return Result.ok();
  });

export const readLaunchd = () =>
  Result.gen(async function* () {
    const env: Record<string, string> = {};
    for (const name of REGISTERED_ENV_NAMES) {
      const read = yield* Result.await(
        runCommand("/bin/launchctl", ["getenv", name], process.env),
      );
      if (read.status === 0 && read.stdout !== "")
        env[name] = read.stdout.replace(/\n$/, "");
      else if (read.status !== 0 && read.status !== 1)
        return Result.err(
          new LaunchdReadFailed({
            message: `cannot read launchd variable ${name}`,
          }),
        );
    }
    const agent = yield* Result.await(readTextFileIfExists(agentPath()));
    return Result.ok({ env, agent });
  });

const agentDirectory = () => join(homedir(), "Library", "LaunchAgents");
const agentPath = () => join(agentDirectory(), `${AGENT_LABEL}.plist`);
