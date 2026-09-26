import { Result } from "better-result";
import { type Signals, signalProcess } from "../boundary/process.ts";

export const SERVER_PID_ENV = "HARNEXUS_SERVER_PID";

// Codex is alive only while it is still this process's parent; without a pid from the launcher nothing is ever signaled, so a reparented bridge cannot mistake launchd or a reused pid for Codex.
export const watchServer = (
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
    signal: (signal: Signals) =>
      isRunning() ? send(pid, signal).map(() => true) : Result.ok(false),
  };
};

// Codex can close stdout and keep running, and once the relay ends the bridge is the only process left to stop it.
export const stopLingeringServer = async ({
  isRunning,
  signal,
  graceMs,
  pollMs = POLL_MS,
}: {
  isRunning: () => boolean;
  signal: (signal: Signals) => void;
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
