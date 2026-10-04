import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { type ImageSource, type ResizeImage, readImage } from "./images.ts";
import { pngBytes } from "./testing/image-files.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-images-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readImage", () => {
  test("sends a file within Claude's limits as it is", async () => {
    const bytes = pngBytes(1200, 800);
    const path = await writeImage("small.png", bytes);
    const resize = recordResize();

    const read = await readImage({ path }, resize.run);

    expect(read.isOk() && read.value).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: bytes.toString("base64"),
      },
    });
    expect(resize.calls).toEqual([]);
  });

  test("reads an image from a base64 data URL", async () => {
    const bytes = pngBytes(10, 10);
    const source = {
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    };

    const read = await readImage(source, recordResize().run);

    expect(read.isOk() && read.value.source.data).toBe(
      bytes.toString("base64"),
    );
  });

  test.each<{ name: string; source: () => Promise<ImageSource> }>([
    {
      name: "a file that is gone",
      source: async () => ({ path: join(dir, "missing.png") }),
    },
    { name: "a folder", source: async () => ({ path: dir }) },
    {
      name: "a data URL that is not base64",
      source: async () => ({ dataUrl: "data:image/png,raw" }),
    },
    {
      name: "a header too short to hold a size",
      source: async () => ({
        path: await writeImage("cut.png", pngBytes(10, 10).subarray(0, 24)),
      }),
    },
  ])("reports $name as unreadable", async ({ source }) => {
    const read = await readImage(await source(), recordResize().run);

    expect(read.isErr() && read.error._tag).toBe("ImageUnreadable");
  });

  test.each([
    { name: "text", bytes: Buffer.from("not an image at all, only some text") },
    { name: "a BMP", bytes: Buffer.concat([Buffer.from("BM"), zeros(40)]) },
  ])("refuses $name as an unsupported format", async ({ bytes }) => {
    const path = await writeImage("other.bin", bytes);

    const read = await readImage({ path }, recordResize().run);

    expect(read.isErr() && read.error._tag).toBe("ImageFormatUnsupported");
  });

  test.each([
    { name: "PNG", bytes: pngBytes(1234, 567) },
    { name: "GIF", bytes: gifBytes(1234, 567) },
    { name: "JPEG", bytes: jpegBytes(1234, 567) },
    { name: "lossy WebP", bytes: webpLossyBytes(1234, 567) },
    { name: "lossless WebP", bytes: webpLosslessBytes(1234, 567) },
    { name: "extended WebP", bytes: webpExtendedBytes(1234, 567) },
  ])("re-encodes an oversized $name at its own long edge rather than enlarging it", async ({
    bytes,
  }) => {
    const path = await writeImage("big", padded(bytes));
    const resize = recordResize(pngBytes(1234, 567));

    const read = await readImage({ path }, resize.run);

    expect(read.isOk()).toBe(true);
    expect(resize.calls[0]?.longEdge).toBe(1234);
  });

  test.each([
    { name: "a PNG", bytes: pngBytes(4000, 3000), format: "png" },
    { name: "a JPEG", bytes: jpegBytes(3000, 4000), format: "jpeg" },
  ])("shrinks $name longer than 2000 pixels to 2000 in its own format", async ({
    bytes,
    format,
  }) => {
    const path = await writeImage("wide", bytes);
    const smaller = pngBytes(2000, 1500);
    const resize = recordResize(smaller);

    const read = await readImage({ path }, resize.run);

    expect(resize.calls).toEqual([{ longEdge: 2000, format }]);
    expect(read.isOk() && read.value.source).toEqual({
      type: "base64",
      media_type: `image/${format}`,
      data: smaller.toString("base64"),
    });
  });

  test("falls back to JPEG when the shrunk PNG is still too large", async () => {
    const path = await writeImage("noisy.png", pngBytes(4000, 3000));
    const outputs = [padded(pngBytes(2000, 1500)), pngBytes(2000, 1500)];
    const calls: string[] = [];

    const read = await readImage({ path }, async (_bytes, _edge, format) => {
      calls.push(format);
      return Result.ok(outputs.shift() ?? Buffer.alloc(0));
    });

    expect(calls).toEqual(["png", "jpeg"]);
    expect(read.isOk() && read.value.source.media_type).toBe("image/jpeg");
  });

  test.each<{ name: string; resize: ResizeImage }>([
    {
      name: "cannot be resized",
      resize: async () => Result.err({ _tag: "ImageResizeFailed" }),
    },
    {
      name: "stays too large once resized",
      resize: async () => Result.ok(padded(pngBytes(2000, 1500))),
    },
  ])("refuses an image that $name as too large", async ({ resize }) => {
    const path = await writeImage("huge.png", pngBytes(5000, 5000));

    const read = await readImage({ path }, resize);

    expect(read.isErr() && read.error._tag).toBe("ImageTooLarge");
  });
});

const writeImage = async (name: string, bytes: Uint8Array) => {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
};

const recordResize = (output: Uint8Array = pngBytes(10, 10)) => {
  const calls: { longEdge: number; format: string }[] = [];
  const run: ResizeImage = async (_bytes, longEdge, format) => {
    calls.push({ longEdge, format });
    return Result.ok(output);
  };
  return { calls, run };
};

// Past the 5 MB of base64 Claude takes for one image.
const padded = (bytes: Uint8Array) => Buffer.concat([bytes, zeros(4_000_000)]);

const zeros = (length: number) => Buffer.alloc(length);

const gifBytes = (width: number, height: number) => {
  const bytes = zeros(40);
  bytes.write("GIF89a", 0, "latin1");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
};

// An APP0 segment comes before the frame, as in most camera and screenshot files.
const jpegBytes = (width: number, height: number) => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...zeros(14)]);
  const frame = zeros(19);
  frame.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame, zeros(16)]);
};

const webp = (chunk: string, body: Buffer) => {
  const bytes = zeros(20 + body.length + 8);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write(chunk, 12, "latin1");
  bytes.writeUInt32LE(body.length, 16);
  body.copy(bytes, 20);
  return bytes;
};

const webpLossyBytes = (width: number, height: number) => {
  const body = zeros(10);
  body.set([0x9d, 0x01, 0x2a], 3);
  body.writeUInt16LE(width, 6);
  body.writeUInt16LE(height, 8);
  return webp("VP8 ", body);
};

const webpLosslessBytes = (width: number, height: number) => {
  const body = zeros(5);
  body[0] = 0x2f;
  body.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return webp("VP8L", body);
};

const webpExtendedBytes = (width: number, height: number) => {
  const body = zeros(10);
  body.writeUIntLE(width - 1, 4, 3);
  body.writeUIntLE(height - 1, 7, 3);
  return webp("VP8X", body);
};
