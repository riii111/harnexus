import { resolve } from "node:path";

// Spelling differences such as a trailing slash do not change the directory; symlinks are not resolved, since that needs the file system.
export const isSameDirectory = (a: string, b: string) =>
  resolve(a) === resolve(b);
