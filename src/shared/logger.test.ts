import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createLogger, type LogEvent } from "./logger.ts";

const stdoutWrite = spyOn(process.stdout, "write");

afterEach(() => {
  stdoutWrite.mockClear();
});

describe("createLogger", () => {
  test("writes one JSON line per event to the sink", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    logger.log({ event: "codex_exited", code: null, signal: "SIGTERM" });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      event: "codex_exited",
      code: null,
      signal: "SIGTERM",
    });
  });

  test("drops fields outside the event shape", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    const entry = {
      event: "bridge_started",
      params: { token: "secret-token", prompt: "private text" },
    } as const;
    const widened: LogEvent = entry;

    logger.log(widened);

    expect(lines.join("")).not.toContain("secret-token");
    expect(lines.join("")).not.toContain("private text");
  });

  test("defaults to stderr and never writes to stdout", () => {
    const stderrWrite = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );

    createLogger().log({ event: "bridge_started" });

    expect(stderrWrite).toHaveBeenCalledTimes(1);
    expect(stdoutWrite).not.toHaveBeenCalled();
    stderrWrite.mockRestore();
  });
});
