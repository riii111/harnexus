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

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
