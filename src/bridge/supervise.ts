import { Result } from "better-result";
import { type Signal, signalProcess } from "../boundary/process.ts";

const SERVER_PID_ENV = "HARNEXUS_SERVER_PID";

export type ServerSignalEvent =
  | { event: "server_signaled"; signal: Signal }
  | { event: "server_signal_failed"; signal: Signal; code: string | null };

export const serializeServerSignalEvent = (entry: ServerSignalEvent) => {
  switch (entry.event) {
    case "server_signaled":
      return { event: entry.event, signal: entry.signal };
    case "server_signal_failed":
      return { event: entry.event, signal: entry.signal, code: entry.code };
  }
};

// The server is alive only while it is still this process's parent; without a pid from the launcher nothing is ever signaled, so a reparented bridge cannot mistake launchd or a reused pid for the server.
export const serverFromEnv = (
  env: NodeJS.ProcessEnv,
  {
    parentPid = () => process.ppid,
    send = signalProcess,
  }: {
    parentPid?: () => number;
    send?: typeof signalProcess;
  } = {},
) => {
  const pid = Number(env[SERVER_PID_ENV]);
  const known = Number.isInteger(pid) && pid > 1;
  const isRunning = () => known && parentPid() === pid;
  return {
    isRunning,
    signal: (signal: Signal) =>
      isRunning() ? send(pid, signal).map(() => true) : Result.ok(false),
  };
};

// The errno code tells a refused signal (EPERM) apart from a server that exited just before it (ESRCH).
export const signalWithLog =
  (
    server: Pick<ReturnType<typeof serverFromEnv>, "signal">,
    log: (entry: ServerSignalEvent) => void,
  ) =>
  (signal: Signal) => {
    const sent = server.signal(signal);
    if (sent.isErr()) {
      log({ event: "server_signal_failed", signal, code: sent.error.code });
    } else if (sent.value) {
      log({ event: "server_signaled", signal });
    }
  };

// The server can close stdout and keep running, and once the relay ends the bridge is the only process left to stop it.
export const stopLingeringServer = async ({
  isRunning,
  signal,
  graceMs,
  pollMs = POLL_MS,
}: {
  isRunning: () => boolean;
  signal: (signal: Signal) => void;
  graceMs: number;
  pollMs?: number;
}) => {
  const exitsWithin = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (isRunning()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return true;
  };
  if (await exitsWithin(graceMs)) return;
  signal("SIGTERM");
  if (await exitsWithin(graceMs)) return;
  signal("SIGKILL");
  await exitsWithin(graceMs);
};

const POLL_MS = 20;
