import { matchError, Result, TaggedError } from "better-result";
import { z } from "zod";
import {
  type CronRecord,
  listAutomationIds,
  readAutomation,
} from "./automations.boundary.ts";
import type { AppToolCalls } from "./link-calls.ts";
import { defineTool, failure, withNote } from "./link-results.ts";

class AutomationUnreadable extends TaggedError("AutomationUnreadable")<{
  id: string;
  cause: { message: string };
  message: string;
}> {}

class CronRecordUnreadable extends TaggedError("CronRecordUnreadable")<{
  cause: { message: string };
  message: string;
}> {}

class AutomationNotReachable extends TaggedError("AutomationNotReachable")<{
  id: string;
  message: string;
}> {}

class AutomationsUnlistable extends TaggedError("AutomationsUnlistable")<{
  cause: { message: string };
  message: string;
}> {}

class CronNotIdentified extends TaggedError("CronNotIdentified")<{
  message: string;
}> {}

// A heartbeat is reachable only when it wakes this thread and a cron only when a Claude thread created it here, since the app changes whatever automation an id names and these calls skip its approval.
export const createAutomationTool = ({
  callerThreadId,
  codexHome,
  cronRecord,
  calls,
}: {
  callerThreadId: string;
  codexHome: string;
  cronRecord: Pick<CronRecord, "has" | "add" | "remove">;
  calls: Pick<AppToolCalls, "read" | "write" | "currentGeneration">;
}) => {
  const { read, write } = calls;

  const updateAutomation = async ({
    mode,
    id,
    kind,
    runSettings,
    ...fields
  }: z.infer<z.ZodObject<typeof AUTOMATION_ARGS>>) => {
    const queuedIn = calls.currentGeneration();
    // Compared without case or separators, so a snake_case spelling of a field cannot slip past.
    const reserved = Object.keys(runSettings ?? {}).filter((key) =>
      RESERVED_RUN_SETTINGS.has(key.replace(/[-_]/g, "").toLowerCase()),
    );
    if (reserved.length > 0) {
      return failure(
        `runSettings cannot hold ${reserved.join(", ")}; give the schedule and its text as their own arguments.`,
      );
    }
    if (mode === "create") {
      if (id !== undefined) {
        return failure(
          "Leave id out to create an automation; it names an existing one to view, update or delete.",
        );
      }
      if (kind === "cron") {
        if (fields.name === undefined || fields.prompt === undefined) {
          return failure(
            "A cron automation needs a name and a prompt, by which the new automation is told apart from others; nothing was sent.",
          );
        }
        return createCron({ ...(runSettings ?? {}), ...fields }, queuedIn);
      }
      if (runSettings !== undefined) return failure(RUN_SETTINGS_ONLY_FOR_CRON);
      return write(
        "automation_update",
        { mode, ...fields, kind: "heartbeat", targetThreadId: callerThreadId },
        [],
        { queuedIn },
      );
    }
    if (id === undefined) {
      return failure(
        `mode=${mode} needs the id of a heartbeat of this thread or of a cron automation created from a Claude thread.`,
      );
    }
    const reachable = await reachAutomation(id);
    if (reachable.isErr()) return failure(unreachableText(reachable.error));
    const reached = reachable.value;
    if (kind !== undefined && kind !== reached.kind) {
      return failure(
        `Automation ${id} is a ${reached.kind}, and an existing automation keeps its kind; nothing was sent.`,
      );
    }
    if (
      runSettings !== undefined &&
      (reached.kind === "heartbeat" || mode !== "update")
    ) {
      return failure(
        reached.kind === "heartbeat"
          ? RUN_SETTINGS_ONLY_FOR_CRON
          : `runSettings applies only to create and update; leave it out for mode=${mode}.`,
      );
    }
    if (mode === "view") return read("automation_update", { mode, id }, []);
    if (mode === "delete") {
      return write("automation_update", { mode, id }, [], {
        queuedIn,
        onSuccess: async (result) => {
          if (reached.kind !== "cron") return result;
          const removed = await cronRecord.remove(id);
          return removed.isOk()
            ? result
            : withNote(
                result,
                `Automation ${id} was deleted, but its id could not be dropped from the record of crons created from Claude threads (${removed.error.message}).`,
              );
        },
      });
    }
    return write(
      "automation_update",
      reached.kind === "cron"
        ? { mode, id, ...(runSettings ?? {}), ...fields, kind: "cron" }
        : {
            mode,
            id,
            ...fields,
            kind: "heartbeat",
            targetThreadId: callerThreadId,
          },
      [],
      { queuedIn },
    );
  };

  // The app's answer does not reliably name the automation it made, so the new one is found as the cron with the same name and prompt that was not there before the call.
  const createCron = async (
    fields: Record<string, unknown>,
    queuedIn: number | null,
  ) => {
    // Listed inside the write queue just before the send, so only automations made while the call runs look new.
    let existing: ReadonlySet<string> = new Set();
    return write(
      "automation_update",
      { mode: "create", ...fields, kind: "cron" },
      [],
      {
        queuedIn,
        beforeSend: async () => {
          const before = await listAutomationIds(codexHome);
          if (before.isErr()) {
            return `Cannot list the automations to record the new one (${before.error.message}); nothing was sent.`;
          }
          existing = new Set(before.value);
          return null;
        },
        onSuccess: async (result) => {
          const created = await findCreatedCron(existing, fields);
          const recorded = created.isOk()
            ? await cronRecord.add(created.value)
            : null;
          return withNote(
            result,
            created.isOk() && recorded?.isOk() === true
              ? `Created cron automation ${created.value}. Claude threads can view, update or delete it with this id.`
              : `The cron automation was created, but ${created.isErr() ? unidentifiedText(created.error) : `automation ${created.value} could not be recorded`}, so it cannot be viewed, updated or deleted from Claude threads. Do not create it again; ask the user to manage it in the app.`,
          );
        },
      },
    );
  };

  const findCreatedCron = async (
    existing: ReadonlySet<string>,
    fields: Record<string, unknown>,
  ): Promise<Result<string, AutomationsUnlistable | CronNotIdentified>> => {
    const after = await listAutomationIds(codexHome);
    if (after.isErr()) {
      return Result.err(
        new AutomationsUnlistable({
          cause: after.error,
          message: "cannot list the automations",
        }),
      );
    }
    const added = after.value.filter((name) => !existing.has(name));
    const saved = await Promise.all(
      added.map((id) => readAutomation(codexHome, id)),
    );
    const matches = added.filter((_id, index) => {
      const automation = saved[index];
      return (
        automation?.isOk() === true &&
        automation.value?.kind === "cron" &&
        automation.value.name === fields.name &&
        automation.value.prompt === fields.prompt
      );
    });
    const [only] = matches;
    return matches.length === 1 && only !== undefined
      ? Result.ok(only)
      : Result.err(
          new CronNotIdentified({
            message: "no single new cron matches the call",
          }),
        );
  };

  const reachAutomation = async (
    id: string,
  ): Promise<
    Result<
      { kind: "heartbeat" | "cron" },
      AutomationUnreadable | CronRecordUnreadable | AutomationNotReachable
    >
  > => {
    const saved = await readAutomation(codexHome, id);
    if (saved.isErr()) {
      return Result.err(
        new AutomationUnreadable({
          id,
          cause: saved.error,
          message: `cannot read automation ${id}`,
        }),
      );
    }
    if (
      saved.value?.kind !== "cron" &&
      saved.value?.targetThreadId === callerThreadId
    ) {
      return Result.ok({ kind: "heartbeat" });
    }
    // A recorded id whose automation is gone is dropped, so a later automation the app gives the same id is not taken for it.
    if (saved.value === null) await cronRecord.remove(id);
    if (saved.value?.kind === "cron") {
      const recorded = await cronRecord.has(id);
      if (recorded.isErr()) {
        return Result.err(
          new CronRecordUnreadable({
            cause: recorded.error,
            message: "cannot read the record of crons",
          }),
        );
      }
      if (recorded.value) return Result.ok({ kind: "cron" });
    }
    return Result.err(
      new AutomationNotReachable({
        id,
        message: `automation ${id} is neither a heartbeat of this thread nor a cron created from a Claude thread`,
      }),
    );
  };

  return defineTool(
    "automation_update",
    "Schedule this thread to be woken later by a Codex app heartbeat automation, or view, update or delete a heartbeat of this thread. Use it when the user asks you to check back later, monitor or keep an eye on something, follow up, remind them, or keep working on a schedule. Each run arrives in this thread as a <heartbeat> message whose <instructions> hold the saved prompt and whose <automation_id> names the automation; when what it follows is done or no longer worth checking, delete it with that id and say so in your answer. Prefer updating an existing heartbeat of this thread over creating another; to find its id, look in $CODEX_HOME/automations/*/automation.toml (CODEX_HOME defaults to ~/.codex) for one whose target_thread_id is this thread and whose name or prompt matches. kind=cron instead starts a new thread on each run; only crons created from Claude threads can be reached here. The app runs automations only while it is open and the Mac is awake.",
    AUTOMATION_ARGS,
    (args) => updateAutomation(args),
  );
};

const unreachableText = (
  error: AutomationUnreadable | CronRecordUnreadable | AutomationNotReachable,
) =>
  matchError(error, {
    AutomationUnreadable: ({ id, cause }) =>
      `Cannot read automation ${id} to check what it runs (${cause.message}); nothing was sent.`,
    CronRecordUnreadable: ({ cause }) =>
      `Cannot read the record of cron automations created from Claude threads (${cause.message}); nothing was sent.`,
    AutomationNotReachable: ({ id }) =>
      `Automation ${id} is neither a heartbeat of this thread nor a cron automation created from a Claude thread. Only those can be viewed, updated or deleted here; others are managed from their own thread or in the app.`,
  });

const unidentifiedText = (error: AutomationsUnlistable | CronNotIdentified) =>
  matchError(error, {
    AutomationsUnlistable: ({ cause }) =>
      `the automations could not be listed to find it (${cause.message})`,
    CronNotIdentified: () =>
      "it could not be told apart from the other automations",
  });

// A cron never wakes a thread, and the call's own fields are given as arguments, so none of them may come in through runSettings.
const RESERVED_RUN_SETTINGS = new Set([
  "mode",
  "id",
  "kind",
  "targetthreadid",
  "destination",
  "name",
  "prompt",
  "rrule",
  "status",
  "notificationpolicy",
]);
const RUN_SETTINGS_ONLY_FOR_CRON =
  "runSettings applies only to cron automations; leave it out for a heartbeat.";

// The app's own schema, narrowed to heartbeats of the calling thread and crons created from Claude threads; it still checks the values, and update replaces every field it is given.
const AUTOMATION_ARGS = {
  mode: z
    .enum(["create", "view", "update", "delete"])
    .describe(
      "update saves the fields as given, so view the automation first and send its fields in full with only the requested changes.",
    ),
  id: z
    .string()
    .regex(/^(?!\.\.?$)[^/\\]+$/)
    .optional()
    .describe(
      "The automation id, required for view, update and delete and left out for create. A heartbeat run carries it as <automation_id>.",
    ),
  kind: z
    .enum(["heartbeat", "cron"])
    .optional()
    .describe(
      "Only for create; heartbeat by default. A cron needs a name and a prompt.",
    ),
  runSettings: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Only for a cron: the app's other fields, such as its target and model, sent as given.",
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("A short name; choose one if the user gives none."),
  prompt: z
    .string()
    .min(1)
    .optional()
    .describe(
      "What each run should do, in user-visible prose without the schedule. Unless the user asks for periodic updates, tell the run to stay quiet while nothing has changed and to report only a meaningful change, completion, failure or something the user must do. Keep notification preferences out of it.",
    ),
  rrule: z
    .string()
    .min(1)
    .optional()
    .describe(
      "An RRULE in the user's local wall-clock time without DTSTART, such as FREQ=MINUTELY;INTERVAL=30 or FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0. Never show it to the user.",
    ),
  status: z
    .enum(["ACTIVE", "PAUSED"])
    .optional()
    .describe("ACTIVE unless the user asks to start it paused."),
  notificationPolicy: z
    .enum(["failed_runs_only"])
    .nullable()
    .optional()
    .describe(
      "failed_runs_only when the user asks to mute notifications of completed runs, null only when they ask to unmute; leave it out to keep the current setting.",
    ),
};
