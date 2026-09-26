import { Result } from "better-result";
import { openLogSink } from "../boundary/fs.ts";
import { loadLogPath } from "../shared/config.ts";
import { createLogger, type LogSink } from "../shared/logger.ts";

// The app may discard the server's stderr, so HARNEXUS_LOG_PATH keeps a copy in a file.
export const createBridgeLogger = (env: NodeJS.ProcessEnv) => {
  const file = loadLogPath(env).andThen((path) =>
    path === null ? Result.ok(null) : openLogSink(path),
  );
  const appendToFile = file.isOk() ? file.value : null;
  const sink: LogSink = (line) => {
    process.stderr.write(line);
    appendToFile?.(line);
  };
  const logger = createLogger(sink);
  if (file.isErr()) {
    logger.log({ event: "log_file_unavailable", reason: file.error._tag });
  }
  return logger;
};
