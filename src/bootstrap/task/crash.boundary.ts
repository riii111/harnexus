import { FEEDBACK_HINT, type TaskRun } from "../../task/cli.ts";
import { NAME } from "../../task/request.ts";

// Reports an exception nothing expected, such as a Bun API an older runtime lacks, with where to report it.
export const reportCrash = async (
  run: () => Promise<TaskRun>,
): Promise<TaskRun> => {
  try {
    return await run();
  } catch (error) {
    return { code: 1, stdout: "", stderr: crashReport(error) };
  }
};

const crashReport = (error: unknown) => {
  // The exception is a Panic wrapping it once per Result.gen it left, and Bun prints each layer, so only the innermost is shown.
  const cause = innermost(error);
  const detail =
    cause instanceof Error
      ? (cause.stack ?? `${cause.name}: ${cause.message}`)
      : String(cause);
  return `${NAME}: unexpected failure: ${detail}\n${FEEDBACK_HINT}\n`;
};

const innermost = (error: unknown): unknown =>
  error instanceof Error && error.cause !== undefined
    ? innermost(error.cause)
    : error;
