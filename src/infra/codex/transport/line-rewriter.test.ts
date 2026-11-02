import { describe, expect, spyOn, test } from "bun:test";
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

  test("joins a line spread over many chunks without copying earlier chunks again", async () => {
    const chunk = Buffer.alloc(1024, "a");
    const chunkCount = 512;
    const joined = spyOn(Buffer, "concat");
    const rewriter = createLineRewriter((line) => line);
    const output = collect(rewriter);

    for (let sent = 0; sent < chunkCount; sent += 1) rewriter.write(chunk);
    rewriter.end("\n");
    const text = await output;

    const copied = joined.mock.calls.reduce(
      (total, [pieces]) =>
        total + pieces.reduce((sum, piece) => sum + piece.length, 0),
      0,
    );
    joined.mockRestore();
    expect(text).toBe(`${"a".repeat(chunk.length * chunkCount)}\n`);
    expect(copied).toBeLessThan(4 * chunk.length * chunkCount);
  });

  test("holds later lines back until a pending rewrite settles", async () => {
    let settle: (line: Buffer | null) => void = () => {};
    const rewriter = createLineRewriter((line) =>
      line.toString().startsWith("slow")
        ? new Promise<Buffer | null>((resolve) => {
            settle = resolve;
          })
        : line,
    );
    const output = collect(rewriter);

    rewriter.write("first\nslow\nafter\n");
    rewriter.end("next chunk\n");
    await Bun.sleep(0);
    settle(Buffer.from("SLOW\n"));

    expect(await output).toBe("first\nSLOW\nafter\nnext chunk\n");
  });

  test("drops a line whose pending rewrite settles with nothing", async () => {
    const rewriter = createLineRewriter((line) =>
      line.toString().startsWith("drop") ? Promise.resolve(null) : line,
    );
    const output = collect(rewriter);

    rewriter.end("keep\ndrop\nlast\n");

    expect(await output).toBe("keep\nlast\n");
  });
});

const collect = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
};
