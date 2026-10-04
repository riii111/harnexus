import { Result, TaggedError } from "better-result";
import { readRegularFileBytes } from "../../runtime/fs.boundary.ts";

export type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: MediaType; data: string };
};

// The app saves a pasted or picked image to a file and names its path; a data URL carries the image itself.
export type ImageSource = { path: string } | { dataUrl: string };

export type ResizeImage = (
  bytes: Uint8Array,
  longEdge: number,
  format: "png" | "jpeg",
) => Promise<Result<Uint8Array, { _tag: string }>>;

class ImageUnreadable extends TaggedError("ImageUnreadable")<{
  message: string;
}> {}

class ImageFormatUnsupported extends TaggedError("ImageFormatUnsupported")<{
  message: string;
}> {}

class ImageTooLarge extends TaggedError("ImageTooLarge")<{
  message: string;
}> {}

// Claude refuses a whole request once it holds an image over its limits, and a conversation keeps every image it was sent, so an image is brought within them before it reaches Claude.
export const readImage = async (
  source: ImageSource,
  resize: ResizeImage,
): Promise<
  Result<ImageBlock, ImageUnreadable | ImageFormatUnsupported | ImageTooLarge>
> => {
  const read = await bytesOf(source);
  if (read.isErr()) return read;
  const bytes = read.value;
  const mediaType = mediaTypeOf(bytes);
  if (mediaType === null) {
    return Result.err(
      new ImageFormatUnsupported({
        message: "the image is not PNG, JPEG, GIF or WebP",
      }),
    );
  }
  const size = sizeOf(bytes, mediaType);
  if (size === null) {
    return Result.err(
      new ImageUnreadable({ message: "the image size cannot be read" }),
    );
  }
  const longEdge = Math.max(size.width, size.height);
  if (longEdge <= MAX_EDGE && fits(bytes)) {
    return Result.ok(block(mediaType, bytes));
  }
  return shrink(bytes, mediaType, Math.min(longEdge, MAX_EDGE), resize);
};

const bytesOf = async (
  source: ImageSource,
): Promise<Result<Uint8Array, ImageUnreadable | ImageTooLarge>> => {
  if ("dataUrl" in source) {
    const data = DATA_URL.exec(source.dataUrl)?.[1];
    return data === undefined
      ? Result.err(new ImageUnreadable({ message: "not a base64 data URL" }))
      : Result.ok(Buffer.from(data, "base64"));
  }
  const read = await readRegularFileBytes(source.path, MAX_FILE_BYTES);
  if (read.isErr()) {
    return Result.err(new ImageUnreadable({ message: read.error.message }));
  }
  return read.value === null
    ? Result.err(new ImageTooLarge({ message: "the image file is too large" }))
    : Result.ok(read.value);
};

// Text in a screenshot stays readable as PNG, so JPEG is used only for a JPEG or when PNG at the edge is still too large.
const shrink = async (
  bytes: Uint8Array,
  mediaType: MediaType,
  longEdge: number,
  resize: ResizeImage,
): Promise<Result<ImageBlock, ImageTooLarge>> => {
  const formats =
    mediaType === "image/jpeg"
      ? (["jpeg"] as const)
      : (["png", "jpeg"] as const);
  for (const format of formats) {
    const resized = await resize(bytes, longEdge, format);
    if (resized.isOk() && fits(resized.value)) {
      return Result.ok(block(`image/${format}`, resized.value));
    }
  }
  return Result.err(
    new ImageTooLarge({ message: "the image could not be made small enough" }),
  );
};

const block = (mediaType: MediaType, bytes: Uint8Array): ImageBlock => ({
  type: "image",
  source: {
    type: "base64",
    media_type: mediaType,
    data: Buffer.from(bytes).toString("base64"),
  },
});

const fits = (bytes: Uint8Array) =>
  Math.ceil(bytes.length / 3) * 4 <= MAX_BASE64_LENGTH;

type MediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const mediaTypeOf = (bytes: Uint8Array): MediaType | null => {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 4) === "GIF8") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  return null;
};

const sizeOf = (bytes: Uint8Array, mediaType: MediaType) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = <T>(read: () => T) => (bytes.length < 32 ? null : read());
  switch (mediaType) {
    case "image/png":
      return at(() => ({
        width: view.getUint32(16),
        height: view.getUint32(20),
      }));
    case "image/gif":
      return at(() => ({
        width: view.getUint16(6, true),
        height: view.getUint16(8, true),
      }));
    case "image/webp":
      return at(() => webpSize(bytes, view));
    case "image/jpeg":
      return jpegSize(bytes, view);
  }
};

const webpSize = (bytes: Uint8Array, view: DataView) => {
  switch (ascii(bytes, 12, 4)) {
    case "VP8 ":
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    case "VP8L": {
      const bits = view.getUint32(21, true);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    case "VP8X":
      return {
        width: (view.getUint32(24, true) & 0xffffff) + 1,
        height: (view.getUint32(27, true) & 0xffffff) + 1,
      };
    default:
      return null;
  }
};

// The size is in the first start-of-frame segment, which may follow metadata segments such as EXIF.
const jpegSize = (bytes: Uint8Array, view: DataView) => {
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
    } else if (START_OF_FRAME.has(marker)) {
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      };
    } else if (marker >= 0xd0 && marker <= 0xd9) {
      offset += 2;
    } else {
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return null;
};

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
  prefix.every((byte, index) => bytes[index] === byte);

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  Buffer.from(bytes.subarray(start, start + length)).toString("latin1");

// Claude takes at most 5 MB of base64 per image, and at most 2000 pixels a side once a request holds more than 20 images.
const MAX_BASE64_LENGTH = 5 * 1024 * 1024;

const MAX_EDGE = 2000;

const MAX_FILE_BYTES = 64 * 1024 * 1024;

const DATA_URL = /^data:image\/[\w.+-]+;base64,(.*)$/s;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
