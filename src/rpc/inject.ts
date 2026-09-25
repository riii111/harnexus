import { Transform, Writable } from "node:stream";

// The app may split a message across writes, so an injected line waits for a line boundary.
export const createLineInjector = (target: Writable) => {
  let atBoundary = true;
  let broken = false;
  let pending: string[] = [];
  const flushPending = () => {
    for (const line of pending) target.write(line);
    pending = [];
  };
  const stream = new Writable({
    write(chunk: Uint8Array, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      if (bytes.length === 0) {
        callback();
        return;
      }
      const lastNewline = bytes.lastIndexOf(NEWLINE);
      if (pending.length > 0 && lastNewline !== -1) {
        target.write(bytes.subarray(0, lastNewline + 1));
        flushPending();
        const rest = bytes.subarray(lastNewline + 1);
        atBoundary = rest.length === 0;
        target.write(rest, (error) => callback(error ?? null));
        return;
      }
      atBoundary = bytes[bytes.length - 1] === NEWLINE;
      target.write(bytes, (error) => callback(error ?? null));
    },
    final(callback) {
      target.end(() => callback());
    },
  });
  stream.on("error", () => {});
  // A server that exits while a line is being injected fails the write with EPIPE, which must stop the relay instead of crashing it.
  target.on("error", (error) => {
    broken = true;
    pending = [];
    stream.destroy(error);
  });
  return {
    stream,
    inject: (line: string) => {
      if (broken || target.writableEnded) return;
      if (atBoundary) target.write(line);
      else pending.push(line);
    },
  };
};

// The app must never see a response to a request it did not send.
export const createOwnResponseFilter = (
  isOwn: (line: Buffer) => boolean,
  onOwn: (line: Buffer) => void,
) =>
  createLineRewriter((line) => {
    if (!isOwn(line)) return line;
    onOwn(line);
    return null;
  });

// Each complete line is replaced by what rewrite returns, or dropped on null; a trailing partial line at the end passes unchanged.
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
