import type { Signals } from "../boundary/process.ts";

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
