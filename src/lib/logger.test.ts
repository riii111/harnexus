import { describe, expect, test } from "bun:test";
import { createLogger } from "./logger.ts";

describe("createLogger", () => {
  test("writes only the serialized fields, stamped with a time, as one JSON line", () => {
    const lines: string[] = [];
    const logger = createLogger(
      (line) => lines.push(line),
      (entry: { event: string; secret: string }) => ({ event: entry.event }),
    );

    logger.log({ event: "sample", secret: "secret-token" });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    const { time, ...record } = JSON.parse(lines[0] ?? "");
    expect(Number.isNaN(Date.parse(time))).toBe(false);
    expect(record).toEqual({ event: "sample" });
  });
});
