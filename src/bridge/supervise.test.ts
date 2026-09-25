import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import {
  SERVER_PID_ENV,
  stopLingeringServer,
  watchServer,
} from "./supervise.ts";

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

describe("watchServer", () => {
  test("never signals when Codex exited before the bridge started and launchd became the parent", async () => {
    const sent: [number, string][] = [];
    const server = watchServer(
      { [SERVER_PID_ENV]: "4242" },
      { parentPid: () => 1, send: record(sent) },
    );
    const started = Date.now();

    await stopLingeringServer({
      isRunning: server.isRunning,
      signal: server.signal,
      graceMs: 1000,
    });

    expect(server.isRunning()).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(sent).toEqual([]);
  });

  test("never signals without a usable pid from the launcher", () => {
    const sent: [number, string][] = [];
    for (const value of [undefined, "", "1", "0", "-5", "12.5", "abc"]) {
      const server = watchServer(
        { [SERVER_PID_ENV]: value },
        { parentPid: () => 1, send: record(sent) },
      );
      expect(server.isRunning()).toBe(false);
      expect(server.signal("SIGTERM")).toBe(false);
    }

    expect(sent).toEqual([]);
  });

  test("signals the launcher's pid while Codex is still the parent", () => {
    const sent: [number, string][] = [];
    const server = watchServer(
      { [SERVER_PID_ENV]: "4242" },
      { parentPid: () => 4242, send: record(sent) },
    );

    expect(server.isRunning()).toBe(true);
    expect(server.signal("SIGTERM")).toBe(true);
    expect(sent).toEqual([[4242, "SIGTERM"]]);
  });
});

const record = (sent: [number, string][]) => (pid: number, signal: string) => {
  sent.push([pid, signal]);
  return Result.ok(undefined);
};
