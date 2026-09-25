import { access, constants } from "node:fs/promises";
import { Result, TaggedError } from "better-result";

export class FileNotExecutable extends TaggedError("FileNotExecutable")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

export const checkExecutable = (path: string) =>
  Result.tryPromise({
    try: () => access(path, constants.X_OK),
    catch: (cause) =>
      new FileNotExecutable({
        path,
        cause,
        message: `${path} is not an executable file`,
      }),
  });
