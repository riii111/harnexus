import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCommand } from "../../runtime/process.boundary.ts";

const SCRIPT = join(import.meta.dir, "../../../scripts/install-cloud-task.sh");

const run = async (args: string[], path = "/usr/bin:/bin") => {
  const ran = await runCommand("bash", [SCRIPT, ...args], { PATH: path });
  return ran.unwrap();
};

describe("scripts/install-cloud-task.sh", () => {
  test("is valid bash", async () => {
    expect((await runCommand("bash", ["-n", SCRIPT], {})).unwrap().status).toBe(
      0,
    );
  });

  test("rejects a relative prefix", async () => {
    const ran = await run(["--prefix", "bin"]);
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain("--prefix must be an absolute path");
  });

  test("rejects a relative bun path", async () => {
    const ran = await run(["--bun", "./bun"]);
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain("--bun must be an absolute path");
  });

  test("rejects an unknown option", async () => {
    expect((await run(["--nope"])).status).toBe(2);
  });

  test("names how to install the pinned Bun when it is missing", async () => {
    const ran = await run(["--prefix", "/tmp/unused-prefix"]);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("Bun is not available");
    expect(ran.stderr).toContain(
      "npm install --prefix /workspace/.cloud-setup/bun bun@1.4.4",
    );
  });
});
