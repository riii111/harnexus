import { describe, expect, test } from "bun:test";
import { createLineSplitter, type LineEvent } from "./line-splitter.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

const split = (chunks: string[], maxLineBytes = 1024) => {
  const events: LineEvent[] = [];
  const splitter = createLineSplitter(maxLineBytes, (event) =>
    events.push(event),
  );
  for (const chunk of chunks) splitter.push(bytes(chunk));
  splitter.end();
  return events.map((event) =>
    event.kind === "line"
      ? new TextDecoder().decode(event.bytes)
      : "<oversized>",
  );
};

describe("createLineSplitter", () => {
  test("joins a line split across chunks", () => {
    expect(split(['{"a":', "1", "}\n"])).toEqual(['{"a":1}']);
  });

  test("separates several lines in one chunk", () => {
    expect(split(["a\nb\nc\n"])).toEqual(["a", "b", "c"]);
  });

  test("emits a final line without a trailing newline at end", () => {
    expect(split(["a\nb"])).toEqual(["a", "b"]);
  });

  test("keeps empty lines as empty lines", () => {
    expect(split(["\n\na\n"])).toEqual(["", "", "a"]);
  });

  test("reports an oversized line once and resumes after its newline", () => {
    expect(split(["ok\n", "0123", "456789", "abc\nnext\n"], 8)).toEqual([
      "ok",
      "<oversized>",
      "next",
    ]);
  });

  test("accepts a line exactly at the limit", () => {
    expect(split(["12345678\n"], 8)).toEqual(["12345678"]);
  });

  test.each([
    { name: "Uint8Array", make: bytes },
    { name: "Buffer", make: (text: string) => Buffer.from(text) },
  ])("does not keep references to pushed $name chunks", ({ make }) => {
    const events: LineEvent[] = [];
    const splitter = createLineSplitter(1024, (event) => events.push(event));
    const chunk = make("abc");

    splitter.push(chunk);
    chunk.fill(0x78);
    splitter.push(make("\n"));

    const [event] = events;
    expect(
      event?.kind === "line" && new TextDecoder().decode(event.bytes),
    ).toBe("abc");
  });
});
