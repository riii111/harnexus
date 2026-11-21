import { runHarnexus } from "./harnexus-command.ts";

const [command] = process.argv.slice(2);
if (command === "open-app" || command === "doctor" || command === "feedback") {
  // The standalone commands read their options from argv[2] onward.
  process.argv.splice(2, 1);
  if (command === "open-app") await import("./open-app.ts");
  else if (command === "doctor") await import("./doctor.ts");
  else await import("./feedback.ts");
} else {
  const run = await runHarnexus(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    readStdin: () => Bun.stdin.text(),
  });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exit(run.code);
}
