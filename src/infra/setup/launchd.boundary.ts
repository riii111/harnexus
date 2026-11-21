import { homedir } from "node:os";
import { join } from "node:path";

import { Result, TaggedError } from "better-result";

import { readTextFileIfExists, removeFile } from "../../lib/fs.boundary.ts";
import { readCommandOutput, runCommand } from "../../lib/process.boundary.ts";
import { AGENT_LABEL, ownsAgent } from "./launchd-plan.ts";
import { APP_ENV_NAMES, splitVariables } from "./open-app-plan.ts";

class LaunchdReadFailed extends TaggedError("LaunchdReadFailed")<{
  message: string;
}> {}

export type LaunchdPlaces = { launchctl: string; agentDirectory: string };

export const LOGIN_LAUNCHD: LaunchdPlaces = {
  launchctl: "/bin/launchctl",
  agentDirectory: join(homedir(), "Library", "LaunchAgents"),
};

// Removes what an earlier open-app registered for the whole login session, leaving variables another tool set.
export const clearLegacyLaunchd = (places: LaunchdPlaces = LOGIN_LAUNCHD) =>
  Result.gen(async function* () {
    const read = yield* Result.await(readLaunchd(places));
    // A loaded one-shot job would restore the old values at the next login even after its file is gone.
    const target = `gui/${process.getuid?.()}/${AGENT_LABEL}`;
    const loaded = yield* Result.await(
      runCommand(places.launchctl, ["print", target], process.env),
    );
    if (loaded.status === 0)
      yield* Result.await(
        readCommandOutput(places.launchctl, ["bootout", target]),
      );
    const agent = ownsAgent(read.agent);
    if (agent) yield* Result.await(removeFile(agentPath(places)));
    const { owned: variables, foreign: kept } = splitVariables(read.env);
    for (const name of variables) {
      yield* Result.await(
        readCommandOutput(places.launchctl, ["unsetenv", name]),
      );
    }

    return Result.ok({ variables, agent, kept });
  });

export const readLaunchd = (places: LaunchdPlaces = LOGIN_LAUNCHD) =>
  Result.gen(async function* () {
    const env: Record<string, string> = {};
    for (const name of APP_ENV_NAMES) {
      const read = yield* Result.await(
        runCommand(places.launchctl, ["getenv", name], process.env),
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

    const agent = yield* Result.await(readTextFileIfExists(agentPath(places)));
    return Result.ok({ env, agent });
  });

const agentPath = (places: LaunchdPlaces) =>
  join(places.agentDirectory, `${AGENT_LABEL}.plist`);
