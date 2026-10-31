import type { LiveTurn } from "../../presentation/history.ts";

export const LIVE: LiveTurn = {
  turnId: "harnexus-turn-live",
  record: "u2",
  startedAtMs: 1_790_000_000_000,
};

export const statusOf = (turn: {
  id: string;
  status: string;
  completedAt: number | null;
  durationMs: number | null;
}) => [
  turn.id,
  turn.status,
  turn.completedAt === null && turn.durationMs === null,
];
