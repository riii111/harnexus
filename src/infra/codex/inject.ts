import { Writable } from "node:stream";

// The writer on the other side may split a message across writes, so an injected line waits for a line boundary.
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
      // An empty write is how the relay waits for everything written so far, injected lines included, so it goes through the target too.
      if (bytes.length === 0) {
        target.write(bytes, (error) => callback(error ?? null));
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
  // A target that closes while a line is being injected fails the write with EPIPE, which must stop the relay instead of crashing it.
  target.on("error", (error) => {
    broken = true;
    pending = [];
    stream.destroy(error);
  });
  return {
    stream,
    // False means the line was never handed to the target.
    inject: (line: string) => {
      if (broken || target.writableEnded) return false;
      if (atBoundary) target.write(line);
      else pending.push(line);
      return true;
    },
  };
};

const NEWLINE = 0x0a;
