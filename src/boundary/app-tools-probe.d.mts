export type AppToolsProbeStage =
  | "connect_failed"
  | "closed_before_response"
  | "error_response"
  | "invalid_response"
  | "responded"
  | "timeout";

export type AppToolsProbeOutcome = {
  socketExists: boolean;
  connected: boolean;
  sent: boolean;
  stage: AppToolsProbeStage;
  errorCode: string | null;
  tools: string[];
};

export declare const probeAppTools: (
  pipePath: string,
  timeoutMs?: number,
) => Promise<AppToolsProbeOutcome>;

export declare const RUNTIME_FLAGS: string[];
