import type {
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Result, TaggedError } from "better-result";

export type ClaudeQuery = Pick<
  Query,
  "next" | "interrupt" | "accountInfo" | "close"
>;

export type RunQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;

class ClaudeStartFailed extends TaggedError("ClaudeStartFailed")<{
  cause: unknown;
  message: string;
}> {}

class ClaudeAccountUnavailable extends TaggedError("ClaudeAccountUnavailable")<{
  cause: unknown;
  message: string;
}> {}

export class ClaudeStreamFailed extends TaggedError("ClaudeStreamFailed")<{
  cause: unknown;
  message: string;
}> {}

class ClaudeInterruptFailed extends TaggedError("ClaudeInterruptFailed")<{
  cause: unknown;
  message: string;
}> {}

export const openQuery = (
  run: RunQuery,
  prompt: AsyncIterable<SDKUserMessage>,
  options: Options,
) =>
  Result.try({
    try: () => run({ prompt, options }),
    catch: (cause) =>
      new ClaudeStartFailed({ cause, message: "cannot start Claude" }),
  });

export const readAccount = (query: ClaudeQuery) =>
  Result.tryPromise({
    try: () => query.accountInfo(),
    catch: (cause) =>
      new ClaudeAccountUnavailable({
        cause,
        message: "cannot read the Claude account",
      }),
  });

export const nextMessage = (query: ClaudeQuery) =>
  Result.tryPromise({
    try: () => query.next(),
    catch: (cause) =>
      new ClaudeStreamFailed({
        cause,
        message: "the Claude message stream failed",
      }),
  });

export const interruptQuery = (query: ClaudeQuery) =>
  Result.tryPromise({
    try: async () => {
      await query.interrupt();
    },
    catch: (cause) =>
      new ClaudeInterruptFailed({
        cause,
        message: "cannot interrupt the Claude turn",
      }),
  });

// Closing kills the Claude process, and a failure there leaves nothing the caller can do.
export const closeQuery = (query: ClaudeQuery) => {
  try {
    query.close();
  } catch {}
};
