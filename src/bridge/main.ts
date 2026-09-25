import { exitLike } from "../boundary/process.ts";
import { createObserver } from "../rpc/observe.ts";
import { runRelay } from "../rpc/relay.ts";
import { loadCodexPath } from "../shared/config.ts";
import { createLogger } from "../shared/logger.ts";

const logger = createLogger();

const codexPath = await loadCodexPath(process.env);
if (codexPath.isErr()) {
  logger.log({ event: "bridge_startup_failed", reason: codexPath.error._tag });
  process.exit(1);
}

logger.log({ event: "bridge_started" });
const exit = await runRelay(
  codexPath.value,
  process.argv.slice(2),
  process.env,
  {
    input: process.stdin,
    output: process.stdout,
    observer: createObserver(logger.log),
  },
);
if (exit.isErr()) {
  logger.log({ event: "bridge_startup_failed", reason: exit.error._tag });
  process.exit(1);
}

logger.log({ event: "codex_exited", ...exit.value });
exitLike(exit.value);
