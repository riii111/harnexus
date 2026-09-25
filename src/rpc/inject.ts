import { Transform, Writable } from "node:stream";

// The app may split a message across writes, so an injected line waits for the next line boundary and the app's bytes are never reordered.
export const createLineInjector = (target: Writable) => {
  let atBoundary = true;
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
  return {
    stream,
    inject: (line: string) => {
      if (atBoundary) target.write(line);
      else pending.push(line);
    },
  };
};

// Responses to the bridge's own requests are handed to onOwn and never reach the app; every other line passes through unchanged.
export const createOwnResponseFilter = (
  isOwn: (line: Buffer) => boolean,
  onOwn: (line: Buffer) => void,
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
        const line = bytes.subarray(start, newline + 1);
        if (isOwn(line)) onOwn(line);
        else kept.push(line);
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
