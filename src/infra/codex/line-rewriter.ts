import { Transform } from "node:stream";

type Rewritten = Buffer | null;

// A line whose rewrite is still pending holds back every later line, so the output keeps the input's order.
export const createLineRewriter = (
  rewrite: (line: Buffer) => Rewritten | Promise<Rewritten>,
) => {
  // The unfinished line is kept as pieces and joined once its newline arrives, so a line spread over many chunks is copied once rather than once per chunk.
  let carry: Buffer[] = [];
  return new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      const incoming = Buffer.from(chunk);
      const end = incoming.lastIndexOf(NEWLINE) + 1;
      if (end === 0) {
        carry.push(incoming);
        callback();
        return;
      }
      const bytes = Buffer.concat([...carry, incoming.subarray(0, end)]);
      carry = end < incoming.length ? [incoming.subarray(end)] : [];
      const pending = pushLines(splitLines(bytes), rewrite, (kept) =>
        this.push(kept),
      );
      if (pending === null) callback();
      // A rewrite that fails breaks the stream rather than stalling every later line.
      else
        void pending.then(
          () => callback(),
          (error: Error) => callback(error),
        );
    },
    flush(callback) {
      if (carry.length > 0) this.push(Buffer.concat(carry));
      callback();
    },
  });
};

// Null means every line was rewritten at once, so a chunk without a pending line still passes in the same tick.
const pushLines = (
  lines: Buffer[],
  rewrite: (line: Buffer) => Rewritten | Promise<Rewritten>,
  push: (kept: Buffer) => void,
): Promise<void> | null => {
  const kept: Buffer[] = [];
  for (const [index, line] of lines.entries()) {
    const rewritten = rewrite(line);
    if (rewritten instanceof Promise) {
      if (kept.length > 0) push(Buffer.concat(kept));
      return rewritten.then(async (resolved) => {
        if (resolved !== null) push(resolved);
        await pushLines(lines.slice(index + 1), rewrite, push);
      });
    }
    if (rewritten !== null) kept.push(rewritten);
  }
  if (kept.length > 0) push(Buffer.concat(kept));
  return null;
};

const splitLines = (bytes: Buffer) => {
  const lines: Buffer[] = [];
  for (
    let start = 0, newline = bytes.indexOf(NEWLINE);
    newline !== -1;
    start = newline + 1, newline = bytes.indexOf(NEWLINE, start)
  ) {
    lines.push(bytes.subarray(start, newline + 1));
  }
  return lines;
};

const NEWLINE = 0x0a;
