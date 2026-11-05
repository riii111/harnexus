import type { Readable, Writable } from "node:stream";

import { Result, TaggedError } from "better-result";

import { parseJson } from "../../lib/json.boundary.ts";
import { isObject } from "../../lib/object.ts";
import { createLineInjector } from "./transport/inject.ts";
import { createLineRewriter } from "./transport/line-rewriter.ts";

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

export type ServerRequestError =
  | ServerRequestNotSent
  | ServerRequestUnanswered
  | ServerRequestRejected;

export type ServerRequest = (
  method: string,
  params: unknown,
  // The signal ends the wait early, which leaves the request unanswered; with a thread id the time limit stands still while the app asks the user something for that thread.
  options: { timeoutMs: number; signal?: AbortSignal; threadId?: string },
) => Promise<Result<unknown, ServerRequestError>>;

// The bridge's own requests to the server, sent between the app's lines.
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

  // The questions the app has open for each thread, which the server announces when it asks and when the answer arrives.
  const asking = new Map<string, Set<string>>();

  const trackQuestions = (line: Buffer) => {
    if (!line.includes(ELICITATION_BYTES) && !line.includes(RESOLVED_BYTES)) {
      return;
    }

    const parsed = parseJson(line.toString());
    if (parsed.isErr() || !isObject(parsed.value)) return;
    const { method, id, params } = parsed.value;
    if (!isObject(params)) return;
    if (method === ELICITATION && typeof params.threadId === "string") {
      const open = asking.get(params.threadId) ?? new Set<string>();
      asking.set(params.threadId, open.add(String(id)));
    } else if (method === RESOLVED) {
      for (const [thread, open] of asking) {
        open.delete(String(params.requestId));
        if (open.size === 0) asking.delete(thread);
      }
    }
  };

  const dropOwnResponse = (line: Buffer) => {
    trackQuestions(line);
    // The bridge's ids take their own prefix so they never collide with the app's.
    if (sequence === 0 || !line.includes(ID_PREFIX_BYTES)) return line;
    const parsed = parseJson(line.toString());
    if (parsed.isErr() || !isResponse(parsed.value)) return line;
    const response = parsed.value;
    if (!isIssued(response.id)) return line;
    // The app must never see a response to a request it did not send, so even a late answer to a request that already timed out is dropped.
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

  const closeAll = () => {
    closed = true;
    for (const answer of [...pending.values()]) answer({ kind: "closed" });
  };

  const filtered = createLineRewriter(dropOwnResponse);
  serverOutput.on("error", () => filtered.end());
  // A response can only arrive before the server output ends, so everything still waiting then is unanswered.
  filtered.once("finish", closeAll);

  const request: ServerRequest = (
    method,
    params,
    { timeoutMs, signal, threadId },
  ) => {
    sequence += 1;
    const id = `${ID_PREFIX}${sequence}`;
    if (closed) return Promise.resolve(Result.err(notSent(method)));
    return new Promise((resolve) => {
      let timer = setTimeout(expire, timeoutMs);
      function expire() {
        // The user's time to answer is no part of the call's own, so the limit starts again once the question is answered.
        if (threadId !== undefined && asking.has(threadId)) {
          timer = setTimeout(expire, timeoutMs);
          return;
        }

        settle({ kind: "timeout" });
      }

      const abort = () => settle({ kind: "aborted" });
      signal?.addEventListener("abort", abort, { once: true });
      const settle = (answer: Answer) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        pending.delete(id);
        resolve(toResult(method, answer, timeoutMs));
      };

      pending.set(id, settle);
      if (signal?.aborted === true) {
        settle({ kind: "stopped" });
        return;
      }

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
    case "stopped":
      return Result.err(
        new ServerRequestNotSent({
          method,
          message: `the turn was stopped before ${method} was sent, so it was not sent`,
        }),
      );
    case "aborted":
      return Result.err(
        new ServerRequestUnanswered({
          method,
          message: `the wait for ${method} was stopped before it was answered`,
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

const isResponse = (value: unknown): value is Response =>
  // Only a top-level response matches, so the same text nested in another message never does.
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
  | { kind: "aborted" }
  | { kind: "stopped" }
  | { kind: "closed" };

const ID_PREFIX = "harnexus-";
const ELICITATION = "mcpServer/elicitation/request";
const RESOLVED = "serverRequest/resolved";
const ELICITATION_BYTES = Buffer.from(ELICITATION);
const RESOLVED_BYTES = Buffer.from(RESOLVED);
const ID_PREFIX_BYTES = Buffer.from(`"${ID_PREFIX}`);
