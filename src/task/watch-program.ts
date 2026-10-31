import { fileIdentity } from "../runtime/fs.boundary.ts";
import { jsonEqual } from "./format.ts";

// install:task swaps the file at the program's path, so a different file there means a newer harnexus-task is installed.
// The watch then exits non-zero, which launchd's KeepAlive answers by starting the new one.
// Null when the watch cannot tell, so the caller can say so once rather than run stale code without a word.
export const programWatch = async (path: string, compiled: boolean) => {
  if (!compiled) return null;
  const started = await fileIdentity(path);
  if (started === null) return null;

  return async () => {
    const now = await fileIdentity(path);
    // A program missing for now is being reinstalled, and there is nothing to start until it is back.
    return now !== null && !jsonEqual(now, started);
  };
};
