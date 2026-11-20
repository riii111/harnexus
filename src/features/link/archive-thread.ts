import { z } from "zod";

import type { AppToolCalls } from "./calls.ts";
import { defineTool, failure, type ToolResult } from "./results.ts";

// The set_thread_archived tool for a Claude thread, which archives the caller itself only after the turn that asked has ended.
export const createArchiveTool = ({
  callerThreadId,
  calls,
}: {
  callerThreadId: string;
  calls: Pick<AppToolCalls, "write">;
}) => {
  let selfRequested = false;

  const definition = defineTool(
    "set_thread_archived",
    "Archive or unarchive a Codex app thread, such as one you created whose result you have read. Omit threadId to archive this thread itself: that waits until this turn completes and its final answer is saved, and is dropped if the turn is stopped or fails or another message is already waiting.",
    {
      threadId: z.string().min(1).optional(),
      archived: z.boolean(),
    },
    async ({ threadId = callerThreadId, archived }) => {
      if (threadId !== callerThreadId)
        return calls.write("set_thread_archived", { threadId, archived }, [
          threadId,
        ]);
      if (!archived)
        return failure(
          "This thread is running, so it is not archived and cannot be unarchived.",
          "invalid",
        );
      // Archiving during the turn would let the app stop it before the final answer is saved, so the request waits for the turn's end.
      selfRequested = true;
      return {
        content: [
          {
            type: "text",
            text: "This thread will be archived after this turn completes and its final answer is saved. End the turn with the answer to keep.",
          },
        ],
      };
    },
  );

  return {
    definition,
    archiveAfterTurn: async (): Promise<ToolResult | null> => {
      if (!selfRequested) return null;
      selfRequested = false;
      return calls.write(
        "set_thread_archived",
        { threadId: callerThreadId, archived: true },
        [callerThreadId],
        { afterTurn: true, label: "archive of this thread" },
      );
    },
    dropRequest: () => {
      selfRequested = false;
    },
  };
};
