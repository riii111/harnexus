import { describe, expect, spyOn, test } from "bun:test";
import { readCommandOutput, signalProcess } from "./process.boundary.ts";

describe("signalProcess", () => {
  test("keeps the errno code of a signal the system refuses", () => {
    const kill = spyOn(process, "kill").mockImplementation(() => {
      // biome-ignore lint/plugin/no-throw-try-catch: fakes process.kill, which reports refusals by throwing.
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });

    const sent = signalProcess(4242, "SIGTERM");
    kill.mockRestore();

    expect(sent.isErr() && sent.error.code).toBe("EPERM");
  });
});

describe("readCommandOutput", () => {
  test("returns what the command printed", async () => {
    const read = await readCommandOutput("/bin/echo", ["hello"]);

    expect(read.isOk() && read.value).toBe("hello\n");
  });

  test.each([
    {
      name: "a command that exits with an error",
      file: "/usr/bin/false",
      args: [],
      timeoutMs: 1000,
    },
    {
      name: "a command that runs past the timeout",
      file: "/bin/sleep",
      args: ["5"],
      timeoutMs: 50,
    },
  ])("reports $name as a failure", async ({ file, args, timeoutMs }) => {
    const read = await readCommandOutput(file, args, timeoutMs);

    expect(read.isErr() && read.error._tag).toBe("CommandFailed");
  });
});
