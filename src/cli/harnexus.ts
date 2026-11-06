import { runHarnexus } from "./harnexus-command.ts";

const run = await runHarnexus(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  readStdin: () => Bun.stdin.text(),
});
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.code);
