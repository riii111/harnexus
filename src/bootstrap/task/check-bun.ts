import { REPO } from "../repo.ts";
import { readPinnedBun } from "../setup-facts.ts";
import { unpinnedBun } from "./bun-pin.ts";

const problem = unpinnedBun(await readPinnedBun(REPO), Bun.version);
if (problem !== null) {
  process.stderr.write(`build:task: ${problem}\n`);
  process.exitCode = 1;
}
