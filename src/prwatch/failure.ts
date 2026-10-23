import { Result, TaggedError } from "better-result";
import { isObject } from "../runtime/object.ts";

export class WatchFailed extends TaggedError("WatchFailed")<{
  message: string;
}> {}

export const fail = (message: string) =>
  Result.err(new WatchFailed({ message }));

export type Fields = Record<string, unknown>;

export const ioFailed = (error: { message: string; cause?: unknown }) => {
  const { cause } = error;
  const code =
    isObject(cause) && typeof cause.code === "string" ? cause.code : null;
  return new WatchFailed({
    message: code === null ? error.message : `${error.message} (${code})`,
  });
};

export const jsonEqual = (a: unknown, b: unknown) => Bun.deepEquals(a, b, true);
