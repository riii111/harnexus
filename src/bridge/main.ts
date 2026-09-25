import { exitLike, runInherited } from "../boundary/process.ts";
import { loadCodexPath } from "../shared/config.ts";
import { createLogger } from "../shared/logger.ts";

// Started by bin/harnexus-codex for `app-server`. Until the relay exists, the
// standard app-server runs on the same stdio.
const logger = createLogger();

const codexPath = await loadCodexPath(process.env);
if (codexPath.isErr()) {
  logger.log({ event: "bridge_startup_failed", reason: codexPath.error._tag });
  process.exit(1);
}

logger.log({ event: "bridge_started" });
const exit = await runInherited(
  codexPath.value,
  process.argv.slice(2),
  process.env,
);
if (exit.isErr()) {
  logger.log({ event: "bridge_startup_failed", reason: exit.error._tag });
  process.exit(1);
}

logger.log({ event: "codex_exited", ...exit.value });
exitLike(exit.value);
