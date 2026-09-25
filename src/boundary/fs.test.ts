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
import { openAppendSink, readTextFileIfExists, writeFileAtomic } from "./fs.ts";

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
});
