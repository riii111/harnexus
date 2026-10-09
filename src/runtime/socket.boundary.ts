import { chmod, unlink } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { Result, TaggedError } from "better-result";
import { isObject } from "./object.ts";

class SocketInUse extends TaggedError("SocketInUse")<{
  path: string;
  message: string;
}> {}

class SocketListenFailed extends TaggedError("SocketListenFailed")<{
  path: string;
  cause: unknown;
  message: string;
}> {}

class SocketRequestFailed extends TaggedError("SocketRequestFailed")<{
  path: string;
  code: string | null;
  // False when the connection itself failed, so the line was never written.
  connected: boolean;
  message: string;
}> {}

export const serveLines = (
  path: string,
  handle: (line: string) => Promise<string>,
) =>
  Result.gen(async function* () {
    // A socket left by a bridge that is gone refuses connections and is replaced; one that still answers belongs to a running bridge and is kept.
    const owner = await requestLine(path, "", PROBE_TIMEOUT_MS);
    if (owner.isOk() || owner.error.code === "ETIMEDOUT") {
      return Result.err(
        new SocketInUse({
          path,
          message: `${path} is served by another process`,
        }),
      );
    }
    const server = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          await unlink(path).catch((cause) => {
            if (!(isObject(cause) && cause.code === "ENOENT")) throw cause;
          });
          const server = createServer((socket) => {
            let buffered = "";
            socket.setEncoding("utf8");
            socket.on("error", () => socket.destroy());
            socket.on("data", (chunk: string) => {
              buffered += chunk;
              const end = buffered.indexOf("\n");
              if (end === -1) {
                if (buffered.length > LINE_LIMIT) socket.destroy();
                return;
              }
              socket.pause();
              void handle(buffered.slice(0, end)).then((answer) =>
                socket.end(`${answer}\n`),
              );
            });
          });
          await listen(server, path);
          await chmod(path, OWNER_ONLY);
          return server;
        },
        catch: (cause) =>
          new SocketListenFailed({
            path,
            cause,
            message: `cannot listen on ${path}`,
          }),
      }),
    );
    return Result.ok({ close: () => server.close() });
  });

// A socket another bridge serves is checked again until that bridge is gone, since the bridge that took it may be a short-lived one the app started beside this one.
export const serveLinesWhenFree = (
  path: string,
  handle: (line: string) => Promise<string>,
  {
    retryMs = TAKEOVER_RETRY_MS,
    onInUse,
  }: { retryMs?: number; onInUse?: () => void } = {},
) =>
  new Promise<Awaited<ReturnType<typeof serveLines>>>((resolve) => {
    let reported = false;
    const attempt = async () => {
      const served = await serveLines(path, handle);
      if (served.isErr() && served.error._tag === "SocketInUse") {
        if (!reported) onInUse?.();
        reported = true;
        setTimeout(attempt, retryMs).unref();
        return;
      }
      resolve(served);
    };
    void attempt();
  });

// An empty line is only a probe: the server answers nothing to it but the connection proves it is alive.
export const requestLine = (path: string, line: string, timeoutMs: number) => {
  let connected = false;
  return Result.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(path);
        let answer = "";
        const timer = setTimeout(() => {
          socket.destroy();
          reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
        }, timeoutMs);
        socket.setEncoding("utf8");
        socket.on("connect", () => {
          connected = true;
          if (line === "") {
            clearTimeout(timer);
            socket.destroy();
            resolve("");
            return;
          }
          socket.write(`${line}\n`);
        });
        socket.on("data", (chunk: string) => {
          answer += chunk;
        });
        socket.on("end", () => {
          clearTimeout(timer);
          resolve(answer.trimEnd());
        });
        socket.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      }),
    catch: (cause) =>
      new SocketRequestFailed({
        path,
        code:
          isObject(cause) && typeof cause.code === "string" ? cause.code : null,
        connected,
        message: `cannot reach ${path}`,
      }),
  });
};

const listen = (server: Server, path: string) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });

const OWNER_ONLY = 0o600;
const LINE_LIMIT = 1_000_000;
const PROBE_TIMEOUT_MS = 1000;
const TAKEOVER_RETRY_MS = 5000;
