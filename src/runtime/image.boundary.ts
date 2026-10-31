import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import { captureCommand } from "./process.boundary.ts";

class ImageResizeFailed extends TaggedError("ImageResizeFailed")<{
  cause: unknown;
  message: string;
}> {}

// sips ships with macOS and enlarges an image smaller than the edge, so the caller passes an edge no longer than the image's own.
export const resizeImage = (
  bytes: Uint8Array,
  longEdge: number,
  format: "png" | "jpeg",
) =>
  Result.tryPromise({
    try: async () => {
      const dir = await mkdtemp(join(tmpdir(), "harnexus-image-"));
      try {
        const input = join(dir, "input");
        const output = join(dir, `output.${format}`);
        await writeFile(input, bytes, { mode: 0o600 });
        const { error } = await captureCommand(
          SIPS,
          [
            "--resampleHeightWidthMax",
            String(longEdge),
            "--setProperty",
            "format",
            format,
            input,
            "--out",
            output,
          ],
          { timeoutMs: RESIZE_TIMEOUT_MS },
        );
        if (error !== null) throw error;
        return await readFile(output);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    catch: (cause) =>
      new ImageResizeFailed({ cause, message: "cannot resize the image" }),
  });

const SIPS = "/usr/bin/sips";

const RESIZE_TIMEOUT_MS = 30_000;
