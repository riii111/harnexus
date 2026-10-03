import { isObject } from "../../runtime/object.ts";

export type VertexConnection = {
  provider: "vertex";
  projectId: string;
  region: string;
  credentialsFile: string | null;
  models: Readonly<Partial<Record<ModelAlias, string>>>;
  modelRegions: Readonly<Record<string, string>>;
};

export type Connection = { provider: "subscription" } | VertexConnection;

// Any change here changes where the conversation is sent and billed, so a thread keeps exactly these.
export type ConnectionTarget =
  | { provider: "subscription" }
  | { provider: "vertex"; projectId: string; region: string };

export type ModelAlias = "opus" | "sonnet" | "haiku";

export const VERTEX_REGION_PREFIX = "VERTEX_REGION_CLAUDE_";

export const SUBSCRIPTION_CONNECTION: Connection = { provider: "subscription" };

export const targetOf = (
  connection: Connection | ConnectionTarget,
): ConnectionTarget =>
  connection.provider === "subscription"
    ? { provider: "subscription" }
    : {
        provider: "vertex",
        projectId: connection.projectId,
        region: connection.region,
      };

export const sameTarget = (a: ConnectionTarget, b: ConnectionTarget) =>
  a.provider === "subscription" || b.provider === "subscription"
    ? a.provider === b.provider
    : a.projectId === b.projectId && a.region === b.region;

// Credentials, model pins and model regions change how Claude Code reaches the same project, so they restart the session without counting as a move to another connection.
export const sameConnection = (a: Connection, b: Connection) =>
  settingsKey(a) === settingsKey(b);

export const isConnectionTarget = (value: unknown): value is ConnectionTarget =>
  isObject(value) &&
  (value.provider === "subscription" ||
    (value.provider === "vertex" &&
      typeof value.projectId === "string" &&
      value.projectId !== "" &&
      typeof value.region === "string" &&
      value.region !== ""));

const settingsKey = (connection: Connection) =>
  connection.provider === "subscription"
    ? connection.provider
    : JSON.stringify([
        connection.projectId,
        connection.region,
        connection.credentialsFile,
        sortedEntries(connection.models),
        sortedEntries(connection.modelRegions),
      ]);

const sortedEntries = (record: Readonly<Record<string, string>>) =>
  Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
