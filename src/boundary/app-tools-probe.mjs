// Plain JS so the same code runs in the bridge (Bun) and under the Node the app gives MCP servers (CODEX_MCP_NODE_PATH).
// Run as `<node> app-tools-probe.mjs <depth>`: depth 0 probes the app's tool socket and prints one JSON line; a larger depth probes from a descendant that many levels below.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

// Mirrors codex-app-tools 0.1.4: each frame is a 4-byte little-endian length followed by a JSON-RPC message.
export const probeAppTools = (pipePath, timeoutMs = 5000) =>
  new Promise((resolve) => {
    const outcome = {
      socketExists: isSocket(pipePath),
      connected: false,
      sent: false,
      stage: "timeout",
      errorCode: null,
      tools: [],
    };
    let pending = Buffer.alloc(0);
    let socket;
    const finish = (stage) => {
      clearTimeout(timer);
      socket?.destroy();
      resolve({ ...outcome, stage });
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    try {
      socket = net.createConnection(pipePath);
    } catch {
      finish("connect_failed");
      return;
    }
    // On macOS a peer that accepts and hangs up at once can fail the connect with ECONNREFUSED (Bun) or EINVAL (Node), so the raw code is kept instead of guessing a refusal; Bun reports a hang-up with "end" and may never emit "close".
    const hungUp = () =>
      finish(outcome.connected ? "closed_before_response" : "connect_failed");
    socket.once("error", (error) => {
      if (typeof error?.code === "string") outcome.errorCode = error.code;
      hungUp();
    });
    socket.once("end", hungUp);
    socket.once("close", hungUp);
    socket.once("connect", () => {
      outcome.connected = true;
      const payload = Buffer.from(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
          params: { threadStartKind: "all" },
        }),
      );
      const frame = Buffer.alloc(4 + payload.length);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);
      socket.write(frame, () => {
        outcome.sent = true;
      });
    });
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const length = pending.readUInt32LE(0);
      if (pending.length < 4 + length) return;
      let message;
      try {
        message = JSON.parse(pending.subarray(4, 4 + length).toString("utf8"));
      } catch {
        finish("invalid_response");
        return;
      }
      if (message.error !== undefined) {
        finish("error_response");
        return;
      }
      const tools = Array.isArray(message.result?.tools)
        ? message.result.tools
        : [];
      outcome.tools = tools.map(
        (tool) => `${tool?.namespace ?? ""}.${tool?.name ?? ""}`,
      );
      finish("responded");
    });
  });

const runAsProbe = async (depth) => {
  const pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH ?? "";
  if (depth > 0) {
    const child = spawn(process.execPath, [SELF, String(depth - 1)], {
      stdio: ["ignore", "inherit", "ignore"],
    });
    child.once("close", (code) => process.exit(code ?? 1));
    child.once("error", () => process.exit(1));
    return;
  }
  const outcome = await probeAppTools(pipePath);
  process.stdout.write(
    `${JSON.stringify({ pid: process.pid, ppid: process.ppid, ...outcome })}\n`,
  );
};

const SELF = fileURLToPath(import.meta.url);

const isSocket = (path) => {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
};

if (process.argv[1] === SELF) await runAsProbe(Number(process.argv[2] ?? "0"));
