import { join } from "node:path";
import { readPinnedBun } from "../setup-facts.ts";
import { unpinnedBun } from "./bun-pin.ts";

const problem = unpinnedBun(
  await readPinnedBun(join(import.meta.dir, "..", "..", "..")),
  Bun.version,
);
if (problem !== null) {
  process.stderr.write(`build:task: ${problem}\n`);
  process.exitCode = 1;
}
