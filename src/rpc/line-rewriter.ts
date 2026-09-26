import { Transform } from "node:stream";

export const createLineRewriter = (
  rewrite: (line: Buffer) => Buffer | null,
) => {
  let carry = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      const bytes = Buffer.concat([carry, Buffer.from(chunk)]);
      let start = 0;
      const kept: Buffer[] = [];
      for (
        let newline = bytes.indexOf(NEWLINE, start);
        newline !== -1;
        newline = bytes.indexOf(NEWLINE, start)
      ) {
        const line = rewrite(bytes.subarray(start, newline + 1));
        if (line !== null) kept.push(line);
        start = newline + 1;
      }
      carry = Buffer.from(bytes.subarray(start));
      if (kept.length > 0) this.push(Buffer.concat(kept));
      callback();
    },
    flush(callback) {
      if (carry.length > 0) this.push(carry);
      callback();
    },
  });
};

const NEWLINE = 0x0a;
