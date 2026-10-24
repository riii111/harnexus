import {
  loadCallSocketPath,
  loadLogPath,
  loadPermissionMode,
  loadStatePath,
  loadUnverifiedCodexPolicy,
} from "../runtime/config.ts";
import { readCheckoutHead, readInstalledPackage } from "./checkout.ts";

// What code and settings a bridge runs with, so a report can tell a bridge started before a pull or bun install from current code; settings are kinds, never paths.
export type BridgeIdentity = {
  commit: string | null;
  bun: string;
  sdk: string | null;
  claudeCode: string | null;
  settings: BridgeSettings;
};

export type BridgeSettings = {
  permissionMode: "default" | "auto" | "invalid";
  unverifiedCodex: "run" | "fallback";
  statePath: "default" | "custom" | "invalid";
  logPath: "default" | "custom" | "off" | "invalid";
  callSocket: "default" | "custom" | "off" | "invalid";
};

export const readBridgeIdentity = async (
  repo: string,
  env: Record<string, string | undefined>,
): Promise<BridgeIdentity> => {
  const [head, sdk] = await Promise.all([
    readCheckoutHead(repo),
    readInstalledPackage(repo, SDK_PACKAGE),
  ]);
  return {
    commit: head?.commit?.slice(0, COMMIT_HEAD) ?? null,
    bun: Bun.version,
    sdk: sdk.version,
    claudeCode: sdk.claudeCodeVersion,
    settings: bridgeSettings(env),
  };
};

export const bridgeSettings = (
  env: Record<string, string | undefined>,
): BridgeSettings => {
  const permission = loadPermissionMode(env);
  const state = loadStatePath(env);
  const log = state.andThen((path) => loadLogPath(env, path));
  const socket = state.andThen((path) => loadCallSocketPath(env, path));
  return {
    permissionMode: permission.isOk() ? permission.value : "invalid",
    unverifiedCodex: loadUnverifiedCodexPolicy(env),
    statePath: state.isErr()
      ? "invalid"
      : isSet(env.HARNEXUS_STATE_PATH)
        ? "custom"
        : "default",
    logPath: log.isErr()
      ? "invalid"
      : log.value === null
        ? "off"
        : log.value.explicit
          ? "custom"
          : "default",
    callSocket: socket.isErr()
      ? "invalid"
      : socket.value === null
        ? "off"
        : env.HARNEXUS_CALL_SOCKET?.startsWith("/")
          ? "custom"
          : "default",
  };
};

const isSet = (value: string | undefined) =>
  value !== undefined && value !== "";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

const COMMIT_HEAD = 12;
