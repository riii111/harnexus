import { matchError, Result, TaggedError } from "better-result";
import { z } from "zod";
import { isObject } from "../../runtime/object.ts";
import { isClaudeModel } from "../claude/models.ts";
import {
  answeredThreadId,
  type CreatedThread,
  type CreateOutcome,
  concludeCreate,
  type DelegationWatch,
  FIRST_TURN_WAIT_MS,
  firstTurnRefusal,
} from "./delegations.ts";
import {
  type AppToolCalls,
  CALL_TIMEOUT_MS,
  notSentAfterStop,
} from "./link-calls.ts";
import { defineTool, failure, type ToolResult } from "./link-results.ts";
import type { ServerRequest } from "./server-requests.ts";

class ModelListUnreadable extends TaggedError("ModelListUnreadable")<{
  cause: { message: string };
  message: string;
}> {}

class NoDefaultModel extends TaggedError("NoDefaultModel")<{
  message: string;
}> {}

type CreateArgs = Record<string, unknown> & {
  model?: string | undefined;
  thinking?: string | undefined;
};

export type ThreadWaits = {
  createdThreadWaitMs?: number;
  firstTurnWaitMs?: number;
};

type CreateAttempt = CreateOutcome & { result: ToolResult; busy: boolean };

type CreateWatch = {
  created: CreatedThread | null;
  outcome: CreateOutcome | null;
  busy: boolean;
};

export const createThreadTool = ({
  callerThreadId,
  request,
  delegations,
  calls,
  createdThreadWaitMs = CREATED_THREAD_WAIT_MS,
  firstTurnWaitMs = FIRST_TURN_WAIT_MS,
}: {
  callerThreadId: string;
  request: ServerRequest;
  delegations: Pick<DelegationWatch, "expect">;
  calls: Pick<
    AppToolCalls,
    | "write"
    | "currentGeneration"
    | "wasStopped"
    | "hasUnknownWrite"
    | "markUnknownWrite"
  >;
} & ThreadWaits) => {
  // The model path only needs the thread's id, while a checked create reports the first turn it saw and whether the thread may exist unseen.
  const createThread = async (
    args: CreateArgs,
    checked: boolean,
  ): Promise<CreateAttempt> => {
    const queuedIn = calls.currentGeneration();
    const model = await childModel(args.model);
    if (model.isErr()) return notCreated(failure(modelRefusal(model.error)));
    if (calls.wasStopped(queuedIn)) {
      return notCreated(notSentAfterStop("create_thread"));
    }
    const watch: CreateWatch = { created: null, outcome: null, busy: false };
    const result = await calls.write(
      "create_thread",
      { ...args, model: model.value },
      [],
      {
        queuedIn,
        beforeSend: () => {
          watch.created = delegations.expect(
            callerThreadId,
            checked
              ? {
                  expected: {
                    model: model.value,
                    effort: args.thinking ?? null,
                  },
                }
              : {},
          );
          if (watch.created !== null) return null;
          watch.busy = true;
          return "An earlier create_thread of this thread has not been confirmed yet, so this one was not sent. Do not create another thread; ask the user to check the app.";
        },
        onSuccess: (answer) => confirmCreated(answer, watch, checked),
      },
    );
    // A write that did not succeed may still have made the thread, so it is concluded here as an answer would be.
    const outcome =
      watch.outcome ??
      (watch.created === null
        ? null
        : await concludeCreate(watch.created, {
            answer: { result },
            waitMs: checked ? 0 : null,
            mayExist: calls.hasUnknownWrite(),
            keepArmed: checked,
          }));
    if (outcome === null) return notCreated(result, watch.busy);
    return {
      ...outcome,
      result,
      // Only this create can have set it, since a write after an unknown one is never sent.
      unknown: calls.hasUnknownWrite() || outcome.unknown,
      busy: watch.busy,
    };
  };

  // A created thread that cannot be named is out of reach but real, so it is treated like an unknown outcome to prevent a duplicate.
  const confirmCreated = async (
    answer: ToolResult,
    watch: CreateWatch,
    checked: boolean,
  ) => {
    const outcome =
      watch.created === null
        ? null
        : await concludeCreate(watch.created, {
            answer: { result: answer },
            waitMs: checked
              ? firstTurnWaitMs
              : answeredThreadId(answer) === null
                ? createdThreadWaitMs
                : null,
            keepArmed: checked,
          });
    watch.outcome = outcome;
    const threadId = outcome?.threadId ?? answeredThreadId(answer);
    if (threadId === null) {
      calls.markUnknownWrite("create_thread");
      return failure(
        "The thread was created, but its id could not be learned from the app, so it cannot be read or messaged from here. Do not create another; ask the user to check the app.",
      );
    }
    const refusal = firstTurnRefusal(outcome?.firstTurn ?? null);
    if (refusal?.kind === "settings") {
      return failure(
        `Thread ${threadId} was created, but its first turn ${refusal.difference}, so it was stopped before it ran.`,
      );
    }
    if (refusal?.kind === "bridge") {
      return failure(
        `Thread ${threadId} was created, but the bridge refused its first turn (${refusal.reason}), so it never ran.`,
      );
    }
    // The app's own answer carries only a provisional id, so the real one is what the model must use from here on.
    return {
      content: [
        {
          type: "text",
          text: `Created thread ${threadId}. Use this threadId with wait_threads, read_thread and send_message_to_thread.`,
        },
      ],
      structuredContent: { threadId },
    } satisfies ToolResult;
  };

  // Keep the default Codex model for existing review callers; a Claude worker is selected explicitly.
  const childModel = async (
    requested: string | undefined,
  ): Promise<Result<string, ModelListUnreadable | NoDefaultModel>> => {
    if (requested !== undefined) return Result.ok(requested);
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const listed = await request(
        "model/list",
        cursor === null ? {} : { cursor },
        { timeoutMs: CALL_TIMEOUT_MS },
      );
      if (listed.isErr()) {
        return Result.err(
          new ModelListUnreadable({
            cause: listed.error,
            message: "cannot read the Codex models",
          }),
        );
      }
      const models = readModelPage(listed.value);
      if (models.defaultModel !== null) return Result.ok(models.defaultModel);
      if (models.nextCursor === null) break;
      cursor = models.nextCursor;
    }
    return Result.err(
      new NoDefaultModel({ message: "the Codex app lists no default model" }),
    );
  };

  const definition = defineTool(
    "create_thread",
    "Start a worker or reviewer in a new Codex app thread and send it the first prompt. Wait for its completion with wait_threads and read its answer with read_thread.",
    {
      prompt: z.string().min(1),
      target: CREATE_TARGET,
      title: z.string().optional(),
      model: z
        .string()
        .optional()
        .describe(
          "A Claude or Codex model for the worker or reviewer; leave it out to use the app's default Codex model.",
        ),
      thinking: z.string().optional(),
    },
    async (args) => (await createThread(args, false)).result,
  );

  const createChecked = async (args: unknown): Promise<CreateAttempt> => {
    const parsed = z.object(definition.inputSchema).safeParse(args);
    if (!parsed.success) {
      return notCreated(
        failure(`Invalid arguments for create_thread: ${parsed.error.message}`),
      );
    }
    return createThread(parsed.data, true);
  };

  return { definition, createChecked };
};

const notCreated = (result: ToolResult, busy = false): CreateAttempt => ({
  result,
  firstTurn: null,
  threadId: null,
  unknown: false,
  busy,
});

const modelRefusal = (error: ModelListUnreadable | NoDefaultModel) =>
  matchError(error, {
    ModelListUnreadable: ({ cause }) =>
      `Cannot read the Codex models to choose the child thread's model (${cause.message}); nothing was created.`,
    NoDefaultModel: () =>
      "The Codex app lists no default model; give create_thread a Codex model. Nothing was created.",
  });

// The server's own model/list, which never includes the Claude models the bridge adds for the app.
const readModelPage = (value: unknown) => {
  const page = isObject(value) ? value : {};
  const data = Array.isArray(page.data) ? page.data : [];
  const found = data.find(
    (model): model is { model: string } =>
      isObject(model) &&
      model.isDefault === true &&
      typeof model.model === "string" &&
      !isClaudeModel(model.model),
  );
  return {
    defaultModel: found?.model ?? null,
    nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
  };
};

const CREATED_THREAD_WAIT_MS = 30_000;
const MAX_MODEL_PAGES = 10;
// TODO: replace each type with z.literal once P8b records the enum values on the app; until then the three forms the app defines are kept and the app checks the values.
const CREATE_TARGET = z
  .union([
    z.strictObject({
      type: z.string(),
      projectId: z.string(),
      environment: z.union([
        z.strictObject({ type: z.string() }),
        z.strictObject({
          type: z.string(),
          startingState: z.union([
            z.strictObject({ type: z.string() }),
            z.strictObject({
              type: z.string(),
              branchName: z.string(),
              onMissing: z.string().optional(),
            }),
          ]),
        }),
      ]),
    }),
    z.strictObject({ type: z.string(), directoryName: z.string().optional() }),
    z.strictObject({ type: z.string(), projectId: z.string() }),
  ])
  .describe(
    'Where the thread runs. Use a project with an environment: { type: "project", projectId, environment: { type: "local" } } runs the child thread in the project\'s checkout, and { type: "project", projectId, environment: { type: "worktree", startingState: { type: "branch", branchName } } } runs it in a new worktree. Always include environment: the app rejects { type: "project", projectId } without one as invalid arguments. The app also defines a directory form ({ type, directoryName }). Use list_projects for project ids; if the app rejects a type value, its error lists the accepted ones.',
  );
