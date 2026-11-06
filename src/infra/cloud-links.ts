import { createHash } from "node:crypto";
import { join } from "node:path";

import { Result, TaggedError } from "better-result";
import { z } from "zod";

import { readTextFileIfExists, writeFileAtomic } from "../lib/fs.boundary.ts";
import { parseJson } from "../lib/json.boundary.ts";
import { acquireLock, LOCK_DEPS, type LockDeps } from "./state-locks.ts";

// A chat opened for a Cloud session, so a session never gets a second one; threadId is null while the opening has not reported back, and such a reservation is never made again, since a chat may have been opened.
export type CloudLinkReservation = {
  sessionId: string;
  threadId: string | null;
  reservedAt: string;
};

const RESERVATION = z.strictObject({
  sessionId: z.string().min(1),
  threadId: z.string().min(1).nullable(),
  reservedAt: z.string().min(1),
});

const RESERVATIONS = z
  .array(RESERVATION)
  .refine(
    (links) =>
      new Set(links.map((link) => link.sessionId)).size === links.length,
    "a session is reserved more than once",
  );

const FILE_VERSION = 1;

export const cloudLinksPath = (stateDir: string) =>
  join(stateDir, CLOUD_LINKS_FILE);

// Kept beside the thread state, which the offline state operations change only while no bridge runs.
const CLOUD_LINKS_FILE = "cloud-links.json";

// imports names each exchange file already taken in, by its content, so running an import again is seen as such.
const STATE = z.strictObject({
  version: z.literal(FILE_VERSION),
  links: RESERVATIONS,
  imports: z.array(
    z.strictObject({ digest: z.string().min(1), importedAt: z.string() }),
  ),
});

// What export writes and import reads, so another tool can convert its own records to and from it.
const EXCHANGE = z.strictObject({
  version: z.literal(FILE_VERSION),
  links: RESERVATIONS,
});

export type CloudLinksState = z.infer<typeof STATE>;

export const EMPTY_CLOUD_LINKS: CloudLinksState = {
  version: FILE_VERSION,
  links: [],
  imports: [],
};

class CloudLinksUnreadable extends TaggedError("CloudLinksUnreadable")<{
  path: string;
  cause?: unknown;
  message: string;
}> {}

class CloudLinksUnwritable extends TaggedError("CloudLinksUnwritable")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

class CloudLinksExchangeInvalid extends TaggedError(
  "CloudLinksExchangeInvalid",
)<{ message: string }> {}

// A missing file holds no reservation; one that cannot be read is an error, so its reservations are never taken for none.
export const readCloudLinks = (path: string) =>
  Result.gen(async function* () {
    const text = yield* Result.await(
      readTextFileIfExists(path).then((read) =>
        read.mapError(
          (cause) =>
            new CloudLinksUnreadable({
              path,
              cause,
              message: `cannot read ${path}`,
            }),
        ),
      ),
    );
    if (text === null) return Result.ok(EMPTY_CLOUD_LINKS);
    const parsed = STATE.safeParse(parseJson(text).unwrapOr(undefined));
    return parsed.success
      ? Result.ok(parsed.data)
      : Result.err(
          new CloudLinksUnreadable({
            path,
            message: `${path} does not match the Cloud link format`,
          }),
        );
  });

// Applies a change to the file as it stands now, under its lock, so bridges and offline operations never write over each other's reservations.
export const updateCloudLinks = <T>(
  path: string,
  change: (state: CloudLinksState) => {
    next: CloudLinksState | null;
    result: T;
  },
  deps: LockDeps = LOCK_DEPS,
) =>
  Result.gen(async function* () {
    const { release } = yield* Result.await(
      acquireLock(`${path}.lock`, LOCK_WAIT_MS, deps),
    );
    try {
      const state = yield* Result.await(readCloudLinks(path));
      const { next, result } = change(state);
      if (next !== null)
        yield* Result.await(
          writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`).then(
            (written) =>
              written.mapError(
                (cause) =>
                  new CloudLinksUnwritable({
                    path,
                    cause,
                    message: `cannot write ${path}`,
                  }),
              ),
          ),
        );
      return Result.ok(result);
    } finally {
      await release();
    }
  });

const LOCK_WAIT_MS = 2_000;

export const exportCloudLinks = (state: CloudLinksState) =>
  `${JSON.stringify(
    {
      version: FILE_VERSION,
      links: [...state.links].sort((a, b) =>
        a.sessionId.localeCompare(b.sessionId),
      ),
    },
    null,
    2,
  )}\n`;

export const parseCloudLinksExchange = (text: string) => {
  const parsed = EXCHANGE.safeParse(parseJson(text).unwrapOr(undefined));
  return parsed.success
    ? Result.ok(parsed.data.links)
    : Result.err(
        new CloudLinksExchangeInvalid({
          message: `expected {"version":1,"links":[{"sessionId","threadId","reservedAt"}]} with each session once: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        }),
      );
};

export type CloudLinksImport = {
  imported: number;
  present: number;
  // Sessions reserved here for another chat than the file names; an import with any is not taken in.
  conflicts: readonly {
    sessionId: string;
    kept: string | null;
    offered: string | null;
  }[];
  alreadyImported: boolean;
};

// Adds the reservations this file lacks and checks the rest against it; a reservation is never removed or changed, so running an import again leaves the file as it was.
export const mergeCloudLinks = (
  state: CloudLinksState,
  offered: readonly CloudLinkReservation[],
  now: Date,
): { next: CloudLinksState | null; result: CloudLinksImport } => {
  const kept = new Map(state.links.map((link) => [link.sessionId, link]));
  const added: CloudLinkReservation[] = [];
  const conflicts: CloudLinksImport["conflicts"][number][] = [];
  let present = 0;
  for (const link of offered) {
    const known = kept.get(link.sessionId);
    if (known === undefined) added.push({ ...link });
    else if (known.threadId === link.threadId) present += 1;
    else
      conflicts.push({
        sessionId: link.sessionId,
        kept: known.threadId,
        offered: link.threadId,
      });
  }

  const digest = digestOf(offered);
  const alreadyImported = state.imports.some((mark) => mark.digest === digest);
  const result = {
    imported: conflicts.length > 0 ? 0 : added.length,
    present,
    conflicts,
    alreadyImported,
  };
  if (conflicts.length > 0 || (added.length === 0 && alreadyImported))
    return { next: null, result };
  return {
    next: {
      ...state,
      links: [...state.links, ...added],
      imports: alreadyImported
        ? state.imports
        : [...state.imports, { digest, importedAt: now.toISOString() }],
    },
    result,
  };
};

// The same reservations in any order make the same digest.
const digestOf = (links: readonly CloudLinkReservation[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        [...links]
          .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
          .map(({ sessionId, threadId, reservedAt }) => [
            sessionId,
            threadId,
            reservedAt,
          ]),
      ),
    )
    .digest("hex");

// What cloud_open asks of the reservations; null answers that they could not be read or written, so no chat is opened.
export type CloudLinkReservations = {
  // Reserves the session, or answers the chat it is already reserved for, null while that opening has not reported back.
  reserve: (
    sessionId: string,
  ) => Promise<
    { reserved: true } | { reserved: false; threadId: string | null } | null
  >;
  confirm: (sessionId: string, threadId: string) => Promise<boolean>;
  // Frees a reservation whose chat was surely not opened.
  release: (sessionId: string) => Promise<boolean>;
};

export const openCloudLinkReservations = (
  path: string,
  deps: LockDeps = LOCK_DEPS,
): CloudLinkReservations => ({
  reserve: async (sessionId) => {
    const updated = await updateCloudLinks<
      { reserved: true } | { reserved: false; threadId: string | null }
    >(
      path,
      (state) => {
        const known = state.links.find((link) => link.sessionId === sessionId);
        if (known !== undefined)
          return {
            next: null,
            result: { reserved: false, threadId: known.threadId },
          };
        return {
          next: {
            ...state,
            links: [
              ...state.links,
              {
                sessionId,
                threadId: null,
                reservedAt: deps.now().toISOString(),
              },
            ],
          },
          result: { reserved: true },
        };
      },
      deps,
    );
    return updated.isOk() ? updated.value : null;
  },
  confirm: async (sessionId, threadId) =>
    (
      await updateCloudLinks(
        path,
        (state) => ({
          next: {
            ...state,
            links: state.links.map((link) =>
              link.sessionId === sessionId && link.threadId === null
                ? { ...link, threadId }
                : link,
            ),
          },
          result: true,
        }),
        deps,
      )
    ).isOk(),
  release: async (sessionId) =>
    (
      await updateCloudLinks(
        path,
        (state) => ({
          next: {
            ...state,
            links: state.links.filter(
              (link) => link.sessionId !== sessionId || link.threadId !== null,
            ),
          },
          result: true,
        }),
        deps,
      )
    ).isOk(),
});
