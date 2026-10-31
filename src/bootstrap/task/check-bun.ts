import { REPO } from "../repo.ts";
import { readPinnedBun } from "../setup-facts.ts";
import { unpinnedBun } from "./bun-pin.ts";

// A compiled harnexus-task carries the Bun that built it, so a Bun other than the pinned one is stopped at the build rather than when a chat calls it.
const problem = unpinnedBun(await readPinnedBun(REPO), Bun.version);
if (problem !== null) {
  process.stderr.write(`build:task: ${problem}\n`);
  process.exitCode = 1;
}
