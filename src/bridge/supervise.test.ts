import { describe, expect, test } from "bun:test";
import { type InferErr, Result } from "better-result";
import type { signalProcess } from "../boundary/process.ts";
import { serverFromEnv, stopLingeringServer } from "./supervise.ts";

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

describe("serverFromEnv", () => {
  test("never signals when Codex exited before the bridge started and launchd became the parent", async () => {
    const sent: [number, string][] = [];
    const server = serverFromEnv(
      { HARNEXUS_SERVER_PID: "4242" },
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

  test.each([
    { name: "no pid", value: undefined },
    { name: "an empty pid", value: "" },
    { name: "launchd's pid", value: "1" },
    { name: "a zero pid", value: "0" },
    { name: "a negative pid", value: "-5" },
    { name: "a fractional pid", value: "12.5" },
    { name: "a non-numeric pid", value: "abc" },
  ])("never signals when the launcher passes $name", ({ value }) => {
    const sent: [number, string][] = [];
    const server = serverFromEnv(
      { HARNEXUS_SERVER_PID: value },
      { parentPid: () => 1, send: record(sent) },
    );

    expect(server.isRunning()).toBe(false);
    expect(server.signal("SIGTERM")).toEqual(Result.ok(false));
    expect(sent).toEqual([]);
  });

  test("signals the launcher's pid while Codex is still the parent", () => {
    const sent: [number, string][] = [];
    const server = serverFromEnv(
      { HARNEXUS_SERVER_PID: "4242" },
      { parentPid: () => 4242, send: record(sent) },
    );

    expect(server.isRunning()).toBe(true);
    expect(server.signal("SIGTERM")).toEqual(Result.ok(true));
    expect(sent).toEqual([[4242, "SIGTERM"]]);
  });

  test("reports a signal the system refuses as a failure with its errno code", () => {
    const server = serverFromEnv(
      { HARNEXUS_SERVER_PID: "4242" },
      { parentPid: () => 4242, send: refuse("EPERM") },
    );

    const sent = server.signal("SIGTERM");

    expect(sent.isErr() && sent.error.code).toBe("EPERM");
  });
});

const record = (sent: [number, string][]) => (pid: number, signal: string) => {
  sent.push([pid, signal]);
  return Result.ok(undefined);
};

const refuse = (code: string) => (pid: number) =>
  Result.err({
    _tag: "ProcessSignalFailed",
    pid,
    code,
    cause: null,
    message: `cannot signal ${pid}`,
  } as InferErr<ReturnType<typeof signalProcess>>);
