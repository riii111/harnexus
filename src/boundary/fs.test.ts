import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppendSink } from "./fs.ts";

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
