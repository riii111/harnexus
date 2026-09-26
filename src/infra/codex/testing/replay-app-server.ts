import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Stand-in for `codex app-server`; exiting on the first mismatch makes the test fail on the exit code instead of waiting for output that never comes.
const [fixturePath = ""] = process.argv.slice(2);

const records: FixtureRecord[] = readFileSync(fixturePath, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();

for (const record of records) {
  const wire = JSON.stringify(record.message);
  if (record.direction === "server_to_app") {
    process.stdout.write(`${wire}\n`);
    continue;
  }
  const received = await lines.next();
  if (received.done || received.value !== wire) process.exit(2);
}

const extra = await lines.next();
process.stdout.end(() => process.exit(extra.done ? 0 : 2));

type FixtureRecord = {
  direction: "app_to_server" | "server_to_app";
  message: unknown;
};
