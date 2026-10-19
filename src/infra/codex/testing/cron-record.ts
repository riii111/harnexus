import { Result } from "better-result";
import type { CronRecord } from "../automations.boundary.ts";

// An in-memory stand-in for the record file, starting with the given ids.
export const createMemoryCronRecord = (
  initial: readonly string[] = [],
): CronRecord & { ids: () => readonly string[] } => {
  const ids = new Set(initial);
  return {
    has: async (id) => Result.ok(ids.has(id)),
    add: async (id) => {
      ids.add(id);
      return Result.ok();
    },
    remove: async (id) => {
      ids.delete(id);
      return Result.ok();
    },
    ids: () => [...ids],
  };
};
