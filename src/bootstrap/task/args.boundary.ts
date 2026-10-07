import { parseArgs } from "node:util";
import { Result, TaggedError } from "better-result";

class ArgumentsInvalid extends TaggedError("ArgumentsInvalid")<{
  message: string;
}> {}

export type OptionTypes = Record<
  string,
  { type: "string" | "boolean"; short?: string }
>;

// Strict, so an unknown option or a stray argument stops the run instead of being ignored.
export const parseOptions = (args: readonly string[], options: OptionTypes) =>
  Result.try({
    try: (): Record<string, unknown> =>
      parseArgs({ args: [...args], options, strict: true }).values,
    catch: (cause) =>
      new ArgumentsInvalid({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
