import { Result, TaggedError } from "better-result";
import { isObject } from "../../runtime/object.ts";
import { createSerialQueue } from "../../runtime/serial-queue.ts";
import { failure, type ToolResult } from "./link-results.ts";
import type { ServerRequest } from "./server-requests.ts";

export type LinkStore = {
  get: (threadId: string) => object | undefined;
};

type AppTool =
  | (typeof READ_TOOLS)[number]
  | "create_thread"
  | "send_message_to_thread"
  | "automation_update";

export type AppToolCalls = ReturnType<typeof createAppToolCalls>;

export const READ_TOOLS = [
  "list_projects",
  "read_thread",
  "wait_threads",
] as const;

export const createAppToolCalls = ({
  callerThreadId,
  store,
  request,
}: {
  callerThreadId: string;
  store: LinkStore;
  request: ServerRequest;
}) => {
  const writes = createSerialQueue();
  let unknownWrite: string | null = null;
  let writesInFlight = 0;
  // Bumped when the turn that queued writes stops, since the SDK's cancel notice never reaches a tool handler's signal.
  let generation = 0;
  // Set from the stop until the next turn sends, so a call that reaches the server late for a stopped turn is not sent either.
  let stopped = false;

  const callApp = async (
    name: AppTool,
    args: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS,
  ) =>
    (
      await request(
        "mcpServer/tool/call",
        {
          threadId: callerThreadId,
          server: CODEX_APP_SERVER,
          tool: name,
          arguments: args,
        },
        { timeoutMs },
      )
    ).andThen(readToolResult);

  const read = async (
    name: AppTool,
    args: Record<string, unknown>,
    targets: readonly string[],
    timeoutMs?: number,
  ) => {
    const refusal = refuseTargets(targets, { allowSelf: true });
    if (refusal !== null) return failure(refusal);
    const called = await callApp(name, args, timeoutMs);
    return called.isOk() ? called.value : failure(called.error.message);
  };

  const write = (
    name: AppTool,
    args: Record<string, unknown>,
    targets: readonly string[],
    {
      queuedIn = currentGeneration(),
      onSuccess = async (result) => result,
      beforeSend = () => null,
    }: {
      queuedIn?: number | null;
      onSuccess?: (result: ToolResult) => Promise<ToolResult>;
      beforeSend?: () => string | null | Promise<string | null>;
    } = {},
  ) =>
    // Writes run one at a time so a write never starts while an earlier one is still undecided, and none runs after one whose outcome is unknown.
    writes.run(CODEX_APP_SERVER, async () => {
      if (unknownWrite !== null) {
        return failure(
          `An earlier ${unknownWrite} call has an unknown outcome and is never repeated automatically. Stop sending or creating threads and ask the user to check the app.`,
        );
      }
      // A write queued behind another is dropped once its turn is stopped, since nobody is left to act on its result.
      if (queuedIn !== generation) return notSentAfterStop(name);
      const refusal = refuseTargets(targets, { allowSelf: false });
      if (refusal !== null) return failure(refusal);
      const unsendable = await beforeSend();
      if (unsendable !== null) return failure(unsendable);
      writesInFlight += 1;
      try {
        const called = await callApp(name, args, WRITE_TIMEOUT_MS);
        if (called.isErr()) {
          if (called.error._tag === "ServerRequestNotSent") {
            return failure(called.error.message);
          }
          // A malformed answer is still an answer to a call that ran, so like a lost one it leaves the outcome unknown.
          unknownWrite = name;
          return failure(
            `${called.error.message}. The ${name} call may or may not have taken effect and will not be repeated; ask the user to check the app.`,
          );
        }
        return called.value.isError === true
          ? called.value
          : await onSuccess(called.value);
      } finally {
        writesInFlight -= 1;
      }
    });

  const currentGeneration = () => (stopped ? null : generation);

  const refuseTargets = (
    targets: readonly string[],
    { allowSelf }: { allowSelf: boolean },
  ) => {
    if (store.get(callerThreadId) === undefined) {
      return "This conversation is not registered as a Claude thread, so it cannot use the Codex app threads.";
    }
    // Messaging this thread itself would start a turn behind the one making the call and could wake itself without end, so it may only be read and waited on.
    // Any other thread the app itself lets the caller reach is a valid target, since parallel threads read, wait on and message one another.
    return allowSelf || !targets.includes(callerThreadId)
      ? null
      : "This thread cannot send a message to itself; it can only read or wait on itself.";
  };

  return {
    read,
    write,
    currentGeneration,
    wasStopped: (queuedIn: number | null) => queuedIn !== generation,
    hasUnknownWrite: () => unknownWrite !== null,
    markUnknownWrite: (name: AppTool) => {
      unknownWrite = name;
    },
    hasUnsettledWrite: () =>
      // A turn that ends while a write is still waiting for its answer cannot know the outcome either, so both count.
      unknownWrite !== null || writesInFlight > 0,
    stopWrites: () => {
      generation += 1;
      stopped = true;
    },
    acceptWrites: () => {
      stopped = false;
    },
  };
};

export const notSentAfterStop = (name: AppTool) =>
  failure(`The turn was stopped before ${name} was sent, so it was not sent.`);

class AppToolAnswerMalformed extends TaggedError("AppToolAnswerMalformed")<{
  message: string;
}> {}

type ContentItem = ToolResult["content"][number];

const readToolResult = (answer: unknown) => {
  if (!isObject(answer) || !Array.isArray(answer.content)) {
    return Result.err(
      new AppToolAnswerMalformed({
        message: "the Codex app answered in an unexpected form",
      }),
    );
  }
  const content = answer.content.flatMap(toContentItem);
  const result: ToolResult = {
    content,
    ...(isObject(answer.structuredContent) && {
      structuredContent: answer.structuredContent,
    }),
    ...(answer.isError === true && { isError: true }),
  };
  // The app answers with text, image and audio items only, so any other item makes the whole answer malformed rather than being dropped.
  return content.length === answer.content.length
    ? Result.ok(result)
    : Result.err(
        new AppToolAnswerMalformed({
          message: "the Codex app answered with content it does not define",
        }),
      );
};

const toContentItem = (item: unknown): ContentItem[] => {
  if (!isObject(item)) return [];
  if (item.type === "text" && typeof item.text === "string") {
    return [{ type: "text", text: item.text }];
  }
  if (
    (item.type === "image" || item.type === "audio") &&
    typeof item.data === "string" &&
    typeof item.mimeType === "string"
  ) {
    return [{ type: item.type, data: item.data, mimeType: item.mimeType }];
  }
  return [];
};

const CODEX_APP_SERVER = "codex_app";
export const CALL_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 120_000;
export const MAX_WAIT_MS = 600_000;
export const WAIT_MARGIN_MS = 30_000;
