import { describe, expect, test } from "bun:test";
import { stopLingeringServer } from "./supervise.ts";

describe("stopLingeringServer", () => {
  test("sends no signal to a server that exits within the grace period", async () => {
    const signals: string[] = [];
    const exitAt = Date.now() + 20;

    await stopLingeringServer({
      isRunning: () => Date.now() < exitAt,
      signal: (signal) => signals.push(signal),
      graceMs: 200,
      pollMs: 5,
    });

    expect(signals).toEqual([]);
  });

  test("stops a lingering server with SIGTERM", async () => {
    const signals: string[] = [];

    await stopLingeringServer({
      isRunning: () => !signals.includes("SIGTERM"),
      signal: (signal) => signals.push(signal),
      graceMs: 30,
      pollMs: 5,
    });

    expect(signals).toEqual(["SIGTERM"]);
  });

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const signals: string[] = [];

    await stopLingeringServer({
      isRunning: () => !signals.includes("SIGKILL"),
      signal: (signal) => signals.push(signal),
      graceMs: 30,
      pollMs: 5,
    });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
