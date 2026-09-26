import type { Readable, Writable } from "node:stream";
import { Result, TaggedError } from "better-result";
import { parseJson } from "../boundary/json.ts";
import { createLineInjector } from "./inject.ts";
import { createLineRewriter } from "./line-rewriter.ts";

class ServerRequestNotSent extends TaggedError("ServerRequestNotSent")<{
  method: string;
  message: string;
}> {}

// The request reached the server, so whatever it asked for may or may not have happened.
class ServerRequestUnanswered extends TaggedError("ServerRequestUnanswered")<{
  method: string;
  message: string;
}> {}

class ServerRequestRejected extends TaggedError("ServerRequestRejected")<{
  method: string;
  code: number | null;
  message: string;
}> {}

type ServerRequestError =
  | ServerRequestNotSent
  | ServerRequestUnanswered
  | ServerRequestRejected;

export type ServerRequest = (
  method: string,
  params: unknown,
  options: { timeoutMs: number },
) => Promise<Result<unknown, ServerRequestError>>;

// Requests from the bridge take string ids with their own prefix so they never collide with the app's, and their responses never reach the app.
export const attachServerRequests = ({
  serverInput,
  serverOutput,
}: {
  serverInput: Writable;
  serverOutput: Readable;
}) => {
  const injector = createLineInjector(serverInput);
  const pending = new Map<string, (answer: Answer) => void>();
  let sequence = 0;
  let closed = false;

  // The app must never see a response to a request it did not send; a late answer to a request that already timed out is still dropped, since the app never sent that id.
  const dropOwnResponse = (line: Buffer) => {
    if (sequence === 0 || !line.includes(ID_PREFIX_BYTES)) return line;
    const parsed = parseJson(line.toString());
    if (parsed.isErr() || !isResponse(parsed.value)) return line;
    const response = parsed.value;
    if (!isIssued(response.id)) return line;
    pending.get(response.id)?.(
      "error" in response
        ? { kind: "rejected", error: response.error }
        : { kind: "result", result: response.result },
    );
    return null;
  };

  const isIssued = (id: string) => {
    const number = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : "";
    return /^[1-9]\d*$/.test(number) && Number(number) <= sequence;
  };

  // A response can only arrive before the server output ends, so everything still waiting then is unanswered.
  const closeAll = () => {
    closed = true;
    for (const answer of [...pending.values()]) answer({ kind: "closed" });
  };

  const filtered = createLineRewriter(dropOwnResponse);
  serverOutput.on("error", () => filtered.end());
  filtered.once("finish", closeAll);

  const request: ServerRequest = (method, params, { timeoutMs }) => {
    sequence += 1;
    const id = `${ID_PREFIX}${sequence}`;
    if (closed) return Promise.resolve(Result.err(notSent(method)));
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
      const settle = (answer: Answer) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(toResult(method, answer, timeoutMs));
      };
      pending.set(id, settle);
      const sent = injector.inject(
        `${JSON.stringify({ id, method, params })}\n`,
      );
      if (!sent) settle({ kind: "notSent" });
    });
  };

  return {
    serverInput: injector.stream,
    serverOutput: serverOutput.pipe(filtered),
    request,
  };
};

const toResult = (
  method: string,
  answer: Answer,
  timeoutMs: number,
): Result<unknown, ServerRequestError> => {
  switch (answer.kind) {
    case "result":
      return Result.ok(answer.result);
    case "rejected":
      return Result.err(
        new ServerRequestRejected({
          method,
          code:
            typeof answer.error?.code === "number" ? answer.error.code : null,
          message:
            typeof answer.error?.message === "string"
              ? answer.error.message
              : `the server rejected ${method}`,
        }),
      );
    case "notSent":
      return Result.err(notSent(method));
    case "timeout":
      return Result.err(
        new ServerRequestUnanswered({
          method,
          message: `the server did not answer ${method} within ${timeoutMs}ms`,
        }),
      );
    case "closed":
      return Result.err(
        new ServerRequestUnanswered({
          method,
          message: `the server closed before answering ${method}`,
        }),
      );
  }
};

const notSent = (method: string) =>
  new ServerRequestNotSent({
    method,
    message: `the connection to the server is closed, so ${method} was not sent`,
  });

// Only a top-level response to an id this module issued matches, so the same text nested in another message never does.
const isResponse = (value: unknown): value is Response =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { id?: unknown }).id === "string" &&
  !("method" in value) &&
  ("result" in value || "error" in value);

type Response =
  | { id: string; result: unknown }
  | { id: string; error: { code?: unknown; message?: unknown } | null };

type Answer =
  | { kind: "result"; result: unknown }
  | { kind: "rejected"; error: { code?: unknown; message?: unknown } | null }
  | { kind: "notSent" }
  | { kind: "timeout" }
  | { kind: "closed" };

const ID_PREFIX = "harnexus-";
const ID_PREFIX_BYTES = Buffer.from(`"${ID_PREFIX}`);
