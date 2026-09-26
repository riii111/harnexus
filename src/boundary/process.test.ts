import { describe, expect, test } from "bun:test";
import { signalProcess } from "./process.ts";

describe("signalProcess", () => {
  test("reports ESRCH when the process has already exited and been reaped", async () => {
    const child = Bun.spawn(["/usr/bin/true"]);
    await child.exited;

    // SIGURG is ignored by default, so a process that reused the pid is left unharmed.
    const sent = signalProcess(child.pid, "SIGURG");

    expect(sent.isErr() && sent.error.code).toBe("ESRCH");
  });
});
