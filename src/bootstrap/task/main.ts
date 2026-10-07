import { runTask, TASK_DEPS } from "./cli.ts";

const run = await runTask(process.argv.slice(2), {
  ...TASK_DEPS,
  env: process.env,
});
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
// Set rather than exiting at once, so output to a pipe is flushed first.
process.exitCode = run.code;
