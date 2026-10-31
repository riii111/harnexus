import { Writable } from "node:stream";

// A stream into target that also takes whole lines injected between the relayed ones.
export const createLineInjector = (
  target: Writable,
  // Sees every byte the target is given, relayed and injected alike, in the order the target gets them.
  tap: (bytes: Uint8Array) => void = () => {},
) => {
  let atBoundary = true;
  let broken = false;
  let pending: string[] = [];
  const write = (
    data: Uint8Array | string,
    callback?: (error?: Error | null) => void,
  ) => {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    if (bytes.length > 0) tap(bytes);
    return callback === undefined
      ? target.write(bytes)
      : target.write(bytes, callback);
  };
  const flushPending = () => {
    for (const line of pending) write(line);
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
        write(bytes.subarray(0, lastNewline + 1));
        flushPending();
        const rest = bytes.subarray(lastNewline + 1);
        atBoundary = rest.length === 0;
        write(rest, (error) => callback(error ?? null));
        return;
      }
      atBoundary = bytes[bytes.length - 1] === NEWLINE;
      write(bytes, (error) => callback(error ?? null));
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
    inject: (line: string) => {
      if (broken || target.writableEnded) return false;
      // The writer on the other side may split a message across writes, so an injected line waits for a line boundary.
      if (atBoundary) write(line);
      else pending.push(line);
      return true;
    },
  };
};

const NEWLINE = 0x0a;
