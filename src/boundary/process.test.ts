import { describe, expect, spyOn, test } from "bun:test";
import { signalProcess } from "./process.ts";

describe("signalProcess", () => {
  test("keeps the errno code of a signal the system refuses", () => {
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });

    const sent = signalProcess(4242, "SIGTERM");
    kill.mockRestore();

    expect(sent.isErr() && sent.error.code).toBe("EPERM");
  });
});
