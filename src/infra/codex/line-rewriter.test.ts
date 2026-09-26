import { describe, expect, test } from "bun:test";
import { createLineRewriter } from "./line-rewriter.ts";

describe("createLineRewriter", () => {
  test("replaces or drops whole lines however the chunks split them", async () => {
    const rewriter = createLineRewriter((line) => {
      const text = line.toString();
      if (text.startsWith("drop")) return null;
      return Buffer.from(text.toUpperCase());
    });
    const output = collect(rewriter);

    rewriter.write("keep\ndr");
    rewriter.write("op me\nlast");
    rewriter.end(" part");

    expect(await output).toBe("KEEP\nlast part");
  });
});

const collect = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
};
