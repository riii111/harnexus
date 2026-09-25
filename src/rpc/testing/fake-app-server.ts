import { writeFileSync } from "node:fs";

// Stand-in for `codex app-server` taking `<mode> [pid file]`; the modes differ only in how they react to input, stdin EOF and SIGTERM.
const [mode = "echo", pidFile] = process.argv.slice(2);

if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));

switch (mode) {
  case "crash":
    process.stdin.once("data", () => process.exit(3));
    break;
  case "echo":
    process.stdin.pipe(process.stdout);
    process.stdin.once("end", () => {
      process.stdout.end(() => process.exit(0));
    });
    break;
  case "ignore-eof":
  case "ignore-term":
    process.stdin.pipe(process.stdout);
    setInterval(() => {}, 60_000);
    if (mode === "ignore-term") process.on("SIGTERM", () => {});
    break;
}
