import { Result } from "better-result";
import {
  type ImageSource,
  type ResizeImage,
  readImage,
} from "../../infra/claude/images.ts";
import type { Refusal } from "../thread-request.ts";

// Images are read together, and the first that cannot be sent decides why the whole message is refused, since Claude would otherwise answer without seeing it.
export const readImages = async (
  sources: readonly ImageSource[],
  resize: ResizeImage,
) => {
  const read = await Promise.all(
    sources.map((source) => readImage(source, resize)),
  );
  return Result.all(read).mapError((error) => ({
    _tag: error._tag,
    refusal: REFUSALS[error._tag],
  }));
};

const REFUSALS = {
  ImageUnreadable: "image_unreadable",
  ImageFormatUnsupported: "image_format",
  ImageTooLarge: "image_too_large",
} as const satisfies Record<string, Refusal>;
