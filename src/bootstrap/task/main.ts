import { runTask, TASK_DEPS } from "../../task/cli.ts";
import { reportCrash } from "./crash.boundary.ts";

const run = await reportCrash(() =>
  runTask(process.argv.slice(2), { ...TASK_DEPS, env: process.env }),
);
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
// Set rather than exiting at once, so output to a pipe is flushed first.
process.exitCode = run.code;
