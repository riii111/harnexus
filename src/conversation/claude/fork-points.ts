import type { readLastRecordUuid } from "../../infra/claude/transcripts.ts";
import type { ThreadValues } from "../thread-values.ts";

export const createForkPoints = ({
  threads,
  lastRecordOf,
}: {
  threads: Pick<ThreadValues, "forkSourceOf" | "forkPinOf">;
  lastRecordOf: (sessionId: string) => ReturnType<typeof readLastRecordUuid>;
}) => {
  const points = new Map<string, { at: string | null }>();

  const note = async (threadId: string) => {
    const source = threads.forkSourceOf(threadId);
    if (source === null) return;
    const pinned = threads.forkPinOf(threadId);
    if (pinned !== null) {
      points.set(threadId, { at: pinned });
      return;
    }
    const read = await lastRecordOf(source);
    if (read.isOk()) points.set(threadId, { at: read.value });
  };

  return {
    note,
    pointOf: (threadId: string) => points.get(threadId),
    // A fork handed back to Codex never starts a session again, so its point is dead.
    forget: (threadId: string) => points.delete(threadId),
  };
};
