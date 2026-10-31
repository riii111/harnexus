import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCommand } from "../runtime/process.boundary.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/install-cloud-task.sh");

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

  test.each<{ name: string; args: string[]; message: string }>([
    {
      name: "a relative prefix",
      args: ["--prefix", "bin"],
      message: "--prefix must be an absolute path",
    },
    {
      name: "a relative bun path",
      args: ["--bun", "./bun"],
      message: "--bun must be an absolute path",
    },
    { name: "an unknown option", args: ["--nope"], message: "usage:" },
  ])("rejects $name", async ({ args, message }) => {
    const ran = await run(args);

    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain(message);
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
