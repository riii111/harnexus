import { join } from "node:path";
import { Result } from "better-result";
import { z } from "zod";
import { fail, type TaskFailed } from "../format.ts";
import { absoluteOr, type Env, homeOf, readJson } from "../request.ts";

export type WatchConfig = z.infer<typeof CONFIG>;

export type IgnoreRule = z.infer<typeof IGNORE_RULE>;

export type ItemKind = (typeof ITEM_KINDS)[number];

export const configPath = (env: Env) =>
  join(
    absoluteOr(env.XDG_CONFIG_HOME, join(homeOf(env), ".config")),
    "harnexus/pr-watch.json",
  );

export const loadConfig = (
  path: string,
): Promise<Result<WatchConfig, TaskFailed>> =>
  Result.gen(async function* () {
    const raw = yield* Result.await(readJson(path));
    const parsed = CONFIG.safeParse(raw);
    if (!parsed.success)
      return fail(`${path} is invalid: ${z.prettifyError(parsed.error)}`);

    // Lower-cased once here, since GitHub matches owners and names without case.
    const repositories = Object.fromEntries(
      Object.entries(parsed.data.repositories).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    return Result.ok({ ...parsed.data, repositories });
  });

// Zod builds each schema from the ones it names, so they are declared from the leaves up.
const LOGIN = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*(\[bot\])?$/);

const ITEM_KINDS = ["inline", "review", "issue_comment"] as const;

const IGNORE_RULE = z.strictObject({
  author: LOGIN,
  kind: z.enum(ITEM_KINDS).optional(),
  bodyIncludes: z.string().min(1).optional(),
});

const CLOCK = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);

// The account is fixed per repository, so switching the active gh account never points a poll at a repository the other account cannot see.
const CONFIG = z.strictObject({
  repositories: z.record(
    z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    z.strictObject({ account: LOGIN }),
  ),
  ignore: z.array(IGNORE_RULE).default([]),
  pollIntervalSeconds: z.number().int().min(30).default(60),
  idleIntervalSeconds: z.number().int().min(60).default(600),
  idleAfterHours: z.number().positive().default(72),
  quietHours: z
    .strictObject({ start: CLOCK, end: CLOCK })
    .nullable()
    .default({ start: "22:00", end: "05:00" }),
});
