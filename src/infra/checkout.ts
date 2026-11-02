import { isAbsolute, join } from "node:path";
import {
  readFileSlice,
  readTextFileIfExists,
  statFileIfExists,
} from "../runtime/fs.boundary.ts";
import { parseJson } from "../runtime/json.boundary.ts";
import { isObject } from "../runtime/object.ts";

export type CheckoutHead = {
  commit: string | null;
  branch: string | null;
  movedAtMs: number | null;
};

export const readCheckoutHead = async (
  repo: string,
): Promise<CheckoutHead | null> => {
  // Git's own files are read rather than running git, since on macOS /usr/bin/git without the developer tools opens an install dialog, and the bridge must start fast.
  const marker = await readTextFileIfExists(join(repo, ".git"));
  if (marker.isOk() && marker.value === null) return null;
  // .git is a file naming the real directory in a worktree, whose refs live in the shared directory its commondir names.
  const gitDir =
    marker.isOk() && marker.value !== null
      ? gitDirOf(repo, marker.value)
      : join(repo, ".git");
  if (gitDir === null) return null;
  const head = await readTextFileIfExists(join(gitDir, "HEAD"));
  if (head.isErr() || head.value === null) return null;
  const common = await readTextFileIfExists(join(gitDir, "commondir"));
  const commonDir =
    common.isOk() && common.value !== null
      ? resolveFrom(gitDir, common.value.trim())
      : gitDir;
  const ref = /^ref: (refs\/\S+)\s*$/.exec(head.value)?.[1] ?? null;
  const commit =
    ref === null
      ? commitOf(head.value)
      : await resolveRef(gitDir, commonDir, ref);
  return {
    commit,
    branch: ref?.replace(/^refs\/heads\//, "") ?? null,
    movedAtMs: await headMovedAt(gitDir),
  };
};

type InstalledPackage = {
  version: string | null;
  claudeCodeVersion: string | null;
};

export const readInstalledPackage = async (
  repo: string,
  name: string,
): Promise<InstalledPackage> => {
  const text = await readTextFileIfExists(
    join(repo, "node_modules", name, "package.json"),
  );
  const parsed =
    text.isOk() && text.value !== null ? parseJson(text.value) : null;
  const manifest = parsed?.isOk() && isObject(parsed.value) ? parsed.value : {};
  return {
    version: versionOf(manifest.version),
    claudeCodeVersion: versionOf(manifest.claudeCodeVersion),
  };
};

export const versionOf = (value: unknown) =>
  typeof value === "string" && VERSION.test(value) ? value : null;

const gitDirOf = (repo: string, marker: string) => {
  const path = /^gitdir: (.+?)\s*$/m.exec(marker)?.[1];
  return path === undefined ? null : resolveFrom(repo, path);
};

const resolveFrom = (base: string, path: string) =>
  isAbsolute(path) ? path : join(base, path);

const commitOf = (text: string) =>
  /^([0-9a-f]{40}|[0-9a-f]{64})\s*$/.exec(text)?.[1] ?? null;

const resolveRef = async (gitDir: string, commonDir: string, ref: string) => {
  for (const dir of new Set([gitDir, commonDir])) {
    const loose = await readTextFileIfExists(join(dir, ref));
    if (loose.isOk() && loose.value !== null) return commitOf(loose.value);
  }
  // A ref git has packed is a line of packed-refs rather than a loose file.
  const packed = await readTextFileIfExists(join(commonDir, "packed-refs"));
  if (packed.isErr() || packed.value === null) return null;
  for (const line of packed.value.split("\n")) {
    const [sha, name] = line.split(" ");
    if (name === ref && sha !== undefined) return commitOf(sha);
  }
  return null;
};

// When the code last changed by checkout, pull or reset, which a commit's date does not tell.
const headMovedAt = async (gitDir: string) => {
  const path = join(gitDir, "logs", "HEAD");
  const found = await statFileIfExists(path);
  if (found.isErr() || found.value === null) return null;
  const start = Math.max(0, found.value.size - REFLOG_TAIL_BYTES);
  const tail = await readFileSlice(path, start, found.value.size - start);
  if (tail.isErr()) return null;
  const last = tail.value.trimEnd().split("\n").at(-1) ?? "";
  // The reflog line names who moved HEAD, so only its time is kept.
  const seconds = / (\d{9,11}) [+-]\d{4}(?:\t|$)/.exec(last)?.[1];
  return seconds === undefined ? null : Number(seconds) * 1000;
};

export const VERSION = /^\d+\.\d+\.\d+[a-zA-Z0-9.+-]{0,40}$/;

const REFLOG_TAIL_BYTES = 4096;
