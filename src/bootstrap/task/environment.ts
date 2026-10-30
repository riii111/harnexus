import { Result } from "better-result";
import { loadCallerSocketPath } from "../../runtime/config.ts";
import { requestLine } from "../../runtime/socket.boundary.ts";
import { fail, type TaskFailed } from "./format.ts";
import { type Env, homeOf } from "./request.ts";

export const EXECUTION_ENV = "HARNEXUS_EXECUTION_ENV";
const CLOUD_HINT_ENV = "CODEX_ENVIRONMENT_ID";
const PROBE_TIMEOUT_MS = 1500;

export type ExecutionEnvironment = "cloud" | "local" | "unknown";

export type Detected = {
  environment: ExecutionEnvironment;
  // Names where the answer came from; never a value of the environment.
  source: "explicit" | typeof CLOUD_HINT_ENV | "harnexus-socket" | "none";
  note: string;
};

const GUESS_NOTE =
  `${CLOUD_HINT_ENV} is an observed variable of Codex Cloud tasks, not a documented guarantee; ` +
  `set ${EXECUTION_ENV}=cloud|local to decide explicitly`;

// Reads the variables only, so a caller that must not touch the app can still tell Cloud apart.
export const declaredEnvironment = (
  env: Env,
): Result<Detected | null, TaskFailed> => {
  const explicit = env[EXECUTION_ENV];
  if (explicit !== undefined && explicit !== "") {
    if (explicit !== "cloud" && explicit !== "local")
      return fail(`${EXECUTION_ENV} must be cloud or local, not "${explicit}"`);
    return Result.ok({
      environment: explicit,
      source: "explicit",
      note: `set by ${EXECUTION_ENV}`,
    });
  }
  const hint = env[CLOUD_HINT_ENV];
  if (hint !== undefined && hint !== "")
    return Result.ok({
      environment: "cloud",
      source: CLOUD_HINT_ENV,
      note: GUESS_NOTE,
    });
  return Result.ok(null);
};

// Local is only claimed once the harnexus call socket answers a connection; a missing variable proves nothing.
export const detectEnvironment = async (
  env: Env,
): Promise<Result<Detected, TaskFailed>> => {
  const declared = declaredEnvironment(env);
  if (declared.isErr() || declared.value !== null)
    return declared.map((value) => value as Detected);
  const path = loadCallerSocketPath(env, () => homeOf(env));
  if (path.isOk()) {
    const answer = await requestLine(path.value, "", PROBE_TIMEOUT_MS);
    if (answer.isOk())
      return Result.ok({
        environment: "local",
        source: "harnexus-socket",
        note: "the harnexus call socket accepted a connection",
      });
  }
  return Result.ok({
    environment: "unknown",
    source: "none",
    note: `no ${EXECUTION_ENV}, no ${CLOUD_HINT_ENV} and no harnexus call socket; set ${EXECUTION_ENV}=cloud|local`,
  });
};

const CLOUD_ALTERNATIVE =
  "Cloud cannot create or resume other tasks or threads from here. " +
  "For a Claude turn inside this task use `harnexus-task claude`; " +
  "PR notifications are not built for Cloud, so check the PR with gh";

// A command that needs the Codex App fails with the Cloud reason instead of a missing-socket hint.
export const refuseInCloud = (
  env: Env,
  command: string,
): Result<void, TaskFailed> =>
  declaredEnvironment(env).andThen((declared) =>
    declared?.environment === "cloud"
      ? fail(
          `${command} needs the Codex App and is unavailable in Cloud. ${CLOUD_ALTERNATIVE}`,
        )
      : Result.ok(),
  );
