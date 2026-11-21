import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearLegacyLaunchd, type LaunchdPlaces } from "./launchd.boundary.ts";

let dir: string;
let places: LaunchdPlaces;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-launchd-"));
  await mkdir(join(dir, "env"));
  await mkdir(join(dir, "agents"));
  const launchctl = join(dir, "launchctl");
  await writeFile(launchctl, fakeLaunchctl(dir));
  await chmod(launchctl, 0o755);
  places = { launchctl, agentDirectory: join(dir, "agents") };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("clearLegacyLaunchd", () => {
  test("removes the variables, the loaded job and the LaunchAgent an earlier open-app registered even after its checkout is gone", async () => {
    await registered({
      CODEX_CLI_PATH: "/deleted/harnexus/bin/harnexus-codex",
      HARNEXUS_CODEX_PATH: "/codex",
      HARNEXUS_CALL_SOCKET: "on",
    });
    await writeFile(join(dir, "loaded"), "");
    await writeFile(agentFile(), LEGACY_AGENT);

    const cleared = await clearLegacyLaunchd(places);

    expect(cleared.isOk() && cleared.value).toEqual({
      variables: [
        "CODEX_CLI_PATH",
        "HARNEXUS_CODEX_PATH",
        "HARNEXUS_CALL_SOCKET",
      ],
      agent: true,
      kept: [],
    });
    expect({
      env: await readdir(join(dir, "env")),
      loaded: existsSync(join(dir, "loaded")),
      agent: existsSync(agentFile()),
    }).toEqual({ env: [], loaded: false, agent: false });
  });

  test("keeps a Codex CLI path, a LaunchAgent and other variables that another tool registered", async () => {
    await registered({
      CODEX_CLI_PATH: "/opt/other/bin/codex-wrapper",
      OTHER_TOOL: "kept",
    });
    await writeFile(agentFile(), FOREIGN_AGENT);

    const cleared = await clearLegacyLaunchd(places);

    expect(cleared.isOk() && cleared.value).toEqual({
      variables: [],
      agent: false,
      kept: ["CODEX_CLI_PATH"],
    });
    expect({
      env: (await readdir(join(dir, "env"))).sort(),
      agent: await readFile(agentFile(), "utf8"),
      calls: await calls(),
    }).toEqual({
      env: ["CODEX_CLI_PATH", "OTHER_TOOL"],
      agent: FOREIGN_AGENT,
      calls: expect.not.stringMatching(/unsetenv|bootout/),
    });
  });

  test("changes nothing when no earlier setup is left", async () => {
    const cleared = await clearLegacyLaunchd(places);

    expect(cleared.isOk() && cleared.value).toEqual({
      variables: [],
      agent: false,
      kept: [],
    });
    expect(await calls()).not.toMatch(/unsetenv|bootout/);
  });

  test("stops before unsetting anything when launchd cannot be read", async () => {
    await registered({ HARNEXUS_CODEX_PATH: "/codex" });
    await writeFile(join(dir, "broken"), "");

    const cleared = await clearLegacyLaunchd(places);

    expect(cleared.isErr() && cleared.error._tag).toBe("LaunchdReadFailed");
    expect(await readdir(join(dir, "env"))).toEqual(["HARNEXUS_CODEX_PATH"]);
  });
});

const registered = async (env: Record<string, string>) => {
  for (const [name, value] of Object.entries(env)) {
    await writeFile(join(dir, "env", name), `${value}\n`);
  }
};

const agentFile = () => join(dir, "agents", "com.harnexus.environment.plist");

const calls = async () =>
  existsSync(join(dir, "calls")) ? readFile(join(dir, "calls"), "utf8") : "";

const fakeLaunchctl = (state: string) => `#!/bin/sh
state='${state}'
printf '%s\\n' "$*" >> "$state/calls"
case "$1" in
  getenv) [ -e "$state/broken" ] && exit 3; [ -f "$state/env/$2" ] || exit 1; cat "$state/env/$2" ;;
  unsetenv) rm -f "$state/env/$2" ;;
  print) [ -e "$state/loaded" ] || exit 113 ;;
  bootout) rm -f "$state/loaded" ;;
  *) exit 2 ;;
esac
`;

const LEGACY_AGENT = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.harnexus.environment</string>
<key>RunAtLoad</key><true/>
</dict></plist>
`;

const FOREIGN_AGENT = `<plist version="1.0"><dict>
<key>Label</key><string>com.example.other</string>
</dict></plist>
`;
