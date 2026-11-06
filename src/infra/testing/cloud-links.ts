import type { CloudLinkReservations } from "../cloud-links.ts";

// Reservations kept in memory, as the file keeps them.
export const createMemoryCloudLinks = (): CloudLinkReservations & {
  links: Map<string, string | null>;
} => {
  const links = new Map<string, string | null>();
  return {
    links,
    reserve: async (sessionId) => {
      if (links.has(sessionId))
        return { reserved: false, threadId: links.get(sessionId) ?? null };
      links.set(sessionId, null);
      return { reserved: true };
    },
    confirm: async (sessionId, threadId) => {
      if (links.get(sessionId) === null) links.set(sessionId, threadId);
      return true;
    },
    release: async (sessionId) => {
      if (links.get(sessionId) === null) links.delete(sessionId);
      return true;
    },
  };
};
