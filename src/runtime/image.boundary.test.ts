import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resizeImage } from "./image.boundary.ts";

// sips ships only with macOS, which is where the bridge runs.
const onMac = process.platform === "darwin";

describe("resizeImage", () => {
  test.skipIf(!onMac)(
    "writes the image at the given long edge in the given format and leaves no files behind",
    async () => {
      const before = await workFolders();

      const resized = await resizeImage(PNG_4X2, 2, "jpeg");

      expect(resized.isOk() && sizeOfJpeg(resized.value)).toEqual({
        width: 2,
        height: 1,
      });
      expect(await workFolders()).toEqual(before);
    },
  );

  test("fails on bytes that are not an image", async () => {
    const resized = await resizeImage(Buffer.from("not an image"), 2, "png");

    expect(resized.isErr() && resized.error._tag).toBe("ImageResizeFailed");
  });
});

const workFolders = async () =>
  (await readdir(tmpdir())).filter((name) =>
    name.startsWith("harnexus-image-"),
  );

const sizeOfJpeg = (bytes: Uint8Array) => {
  const data = Buffer.from(bytes);
  let offset = 2;
  while (offset < data.length) {
    const marker = data[offset + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc2) {
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  return null;
};

// A 4x2 opaque red PNG.
const PNG_4X2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEklEQVR4nGP4z8AARwjWfwYGAG+qB/lC/d2tAAAAAElFTkSuQmCC",
  "base64",
);
