import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Result, TaggedError } from "better-result";

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
        await run(
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
          { timeout: RESIZE_TIMEOUT_MS },
        );
        return await readFile(output);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    catch: (cause) =>
      new ImageResizeFailed({ cause, message: "cannot resize the image" }),
  });

const run = promisify(execFile);

const SIPS = "/usr/bin/sips";

const RESIZE_TIMEOUT_MS = 30_000;
