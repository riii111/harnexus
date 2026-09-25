import { Result } from "better-result";
import { openAppendSink } from "../boundary/fs.ts";
import { exitLike } from "../boundary/process.ts";
import { createObserver } from "../rpc/observe.ts";
import { runRelay } from "../rpc/relay.ts";
import { loadCodexPath, loadLogPath } from "../shared/config.ts";
import { createLogger, type LogSink } from "../shared/logger.ts";
import { startAppToolsProbe } from "./app-tools-probe.ts";

const { logger, logFileFailure } = createBridgeLogger(process.env);
if (logFileFailure !== null) {
  logger.log({ event: "log_file_unavailable", reason: logFileFailure });
}

const codexPath = await loadCodexPath(process.env);
if (codexPath.isErr()) {
  logger.log({ event: "bridge_startup_failed", reason: codexPath.error._tag });
  process.exit(1);
}

logger.log({ event: "bridge_started" });
void startAppToolsProbe(process.env, logger.log);
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

// The app may discard the server's stderr, so HARNEXUS_LOG_PATH also keeps the log in a file; without a usable file the log still reaches stderr.
function createBridgeLogger(env: NodeJS.ProcessEnv) {
  const file = loadLogPath(env).andThen((path) =>
    path === null ? Result.ok(null) : openAppendSink(path),
  );
  const writeFile = file.isOk() ? file.value : null;
  const sink: LogSink = (line) => {
    process.stderr.write(line);
    writeFile?.(line);
  };
  return {
    logger: createLogger(sink),
    logFileFailure: file.isErr() ? file.error._tag : null,
  };
}
