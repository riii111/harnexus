import type { Check } from "./doctor-report.ts";
import { REGISTERED_ENV_NAMES } from "./open-app-plan.ts";

export const AGENT_LABEL = "com.harnexus.environment";

export const environmentCommands = (env: Record<string, string>) =>
  REGISTERED_ENV_NAMES.map((name) =>
    env[name] === undefined
      ? ["unsetenv", name]
      : ["setenv", name, env[name] as string],
  );

export const launchAgent = (env: Record<string, string>) => {
  const script = environmentCommands(env)
    .map((args) => ["/bin/launchctl", ...args].map(shellQuote).join(" "))
    .join(" && ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${AGENT_LABEL}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>${xml(script)}</string></array>
<key>RunAtLoad</key><true/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>
`;
};

export const registrationChecks = (
  expected: Record<string, string>,
  actual: Record<string, string>,
  agent: string | null,
): Check[] => {
  const present = REGISTERED_ENV_NAMES.filter(
    (name) => actual[name] !== undefined,
  );
  const mismatched = REGISTERED_ENV_NAMES.filter(
    (name) => expected[name] !== actual[name],
  );
  return [
    {
      name: "launchd environment",
      status: present.length === 0 || mismatched.length > 0 ? "warn" : "ok",
      detail:
        present.length === 0
          ? "not registered; run bun run open-app"
          : mismatched.length > 0
            ? `values differ from this checkout/shell: ${mismatched.join(", ")}`
            : "registered; values match this checkout/shell",
    },
    {
      name: "Login LaunchAgent",
      status: agent === launchAgent(expected) ? "ok" : "warn",
      detail:
        agent === null
          ? "not installed"
          : agent === launchAgent(expected)
            ? "installed; restores this setup at login"
            : "installed; contents differ from this checkout/shell",
    },
  ];
};

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
