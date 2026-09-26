export type LineEvent =
  | { kind: "line"; bytes: Uint8Array }
  | { kind: "oversized" };

// A line over maxLineBytes is reported once and skipped up to its newline, so a huge message is never held in memory.
export const createLineSplitter = (
  maxLineBytes: number,
  onLine: (event: LineEvent) => void,
) => {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let skipping = false;

  const reset = () => {
    pending = [];
    pendingBytes = 0;
  };

  const emit = () => {
    const bytes = Buffer.concat(pending, pendingBytes);
    reset();
    onLine({ kind: "line", bytes });
  };

  const push = (chunk: Uint8Array) => {
    let start = 0;
    while (start <= chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!skipping) {
        if (pendingBytes + (end - start) > maxLineBytes) {
          skipping = true;
          reset();
          onLine({ kind: "oversized" });
        } else if (end > start) {
          // subarray shares memory, so the bytes are copied explicitly in case the caller reuses the chunk before the line completes.
          pending.push(new Uint8Array(chunk.subarray(start, end)));
          pendingBytes += end - start;
        }
      }
      if (newline === -1) return;
      if (skipping) {
        skipping = false;
      } else {
        emit();
      }
      start = newline + 1;
    }
  };

  const end = () => {
    if (!skipping && pendingBytes > 0) emit();
    skipping = false;
    reset();
  };

  return { push, end };
};

const NEWLINE = 0x0a;
