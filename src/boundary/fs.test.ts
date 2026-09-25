import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmptyFile,
  listFileNames,
  openAppendSink,
  prepareDirectory,
  readTextFileIfExists,
  removeFile,
  writeFileAtomic,
} from "./fs.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-fs-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("openAppendSink", () => {
  test("creates a file readable only by the owner", async () => {
    const path = join(dir, "new.log");

    const sink = openAppendSink(path);
    if (sink.isOk()) sink.value("line\n");

    expect(sink.isOk()).toBe(true);
    expect(await readFile(path, "utf8")).toBe("line\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("narrows an existing readable file before appending to it", async () => {
    const path = join(dir, "existing.log");
    await writeFile(path, "before\n");
    await chmod(path, 0o644);

    const sink = openAppendSink(path);
    if (sink.isOk()) sink.value("after\n");

    expect(sink.isOk()).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe("before\nafter\n");
  });

  test("returns an error when the file cannot be opened", () => {
    const sink = openAppendSink(join(dir, "absent", "x.log"));

    expect(sink.isErr() && sink.error._tag).toBe("LogFileOpenFailed");
  });
});

describe("readTextFileIfExists", () => {
  test("returns null for a missing file", async () => {
    const read = await readTextFileIfExists(join(dir, "missing.json"));

    expect(read.isOk() && read.value).toBeNull();
  });

  test("returns an error for a path that cannot be read", async () => {
    const read = await readTextFileIfExists(dir);

    expect(read.isErr() && read.error._tag).toBe("FileReadFailed");
  });
});

describe("writeFileAtomic", () => {
  test("replaces the content and leaves no temporary file", async () => {
    const target = join(dir, "atomic", "state.json");
    await mkdir(join(dir, "atomic"));
    await writeFile(target, "old");

    const written = await writeFileAtomic(target, "new");

    expect(written.isOk()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("new");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, "atomic"))).toEqual(["state.json"]);
  });

  test("returns an error when the directory is missing", async () => {
    const written = await writeFileAtomic(join(dir, "absent", "x.json"), "new");

    expect(written.isErr() && written.error._tag).toBe("FileWriteFailed");
  });

  test("keeps the target and removes the temporary file when the rename fails", async () => {
    const parent = join(dir, "rename-fails");
    const target = join(parent, "state.json");
    await mkdir(join(target, "occupied"), { recursive: true });

    const written = await writeFileAtomic(target, "new");

    expect(written.isErr() && written.error._tag).toBe("FileWriteFailed");
    expect(await readdir(parent)).toEqual(["state.json"]);
    expect(await readdir(target)).toEqual(["occupied"]);
  });
});

describe("createEmptyFile", () => {
  test("creates an empty owner-only file in a prepared directory", async () => {
    const markers = join(dir, "markers");
    const prepared = await prepareDirectory(markers);
    const marker = join(markers, "a.running");

    const created = await createEmptyFile(marker);

    expect(prepared.isOk()).toBe(true);
    expect(created.isOk()).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("");
    expect((await stat(marker)).mode & 0o777).toBe(0o600);
    const names = await listFileNames(markers);
    expect(names.isOk() && names.value).toEqual(["a.running"]);
  });

  test("refuses an existing file", async () => {
    const markers = join(dir, "existing-marker");
    await prepareDirectory(markers);
    const marker = join(markers, "a.running");
    const first = await createEmptyFile(marker);

    const again = await createEmptyFile(marker);

    expect(first.isOk()).toBe(true);
    expect(again.isErr() && again.error._tag).toBe("FileWriteFailed");
    expect(await readdir(markers)).toEqual(["a.running"]);
  });
});

describe("removeFile", () => {
  test("removes a file", async () => {
    const markers = join(dir, "removal");
    await prepareDirectory(markers);
    const marker = join(markers, "a.running");
    const created = await createEmptyFile(marker);

    const removed = await removeFile(marker);

    expect(created.isOk()).toBe(true);
    expect(removed.isOk()).toBe(true);
    expect(await readdir(markers)).toEqual([]);
  });

  test("treats a missing file as removed", async () => {
    const removed = await removeFile(join(dir, "never-created"));

    expect(removed.isOk()).toBe(true);
  });

  test("reports a file that cannot be removed", async () => {
    await mkdir(join(dir, "busy", "inner"), { recursive: true });

    const removed = await removeFile(join(dir, "busy"));

    expect(removed.isErr() && removed.error._tag).toBe("FileRemoveFailed");
  });
});
