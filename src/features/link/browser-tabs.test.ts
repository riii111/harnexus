import { describe, expect, test } from "bun:test";

import { Result } from "better-result";

import type {
  ServerRequest,
  ServerRequestError,
} from "../../infra/codex/server-requests.ts";
import { createBrowserTabs } from "./browser-tabs.ts";
import type { ToolResult } from "./results.ts";

describe("createBrowserTabs opening", () => {
  test("opens a page in the in-app browser with the chat's session and the turn's id", async () => {
    const { browser, calls } = connect();
    browser.beginTurn({ turnId: "turn-1" });

    const opened = await use(browser, "browser_open_tab", { url: PAGE });

    expect(opened.isError).toBeUndefined();
    expect(calls()).toEqual([
      {
        threadId: "thread-1",
        server: "cua_repl",
        tool: "js",
        arguments: {
          code: expect.stringContaining(`createBrowserTab("iab", "${PAGE}"`),
          title: "Opening a browser tab",
        },
        _meta: {
          "x-codex-turn-metadata": {
            session_id: "session-1",
            thread_id: "thread-1",
            turn_id: "turn-1",
            thread_source: "user",
          },
        },
      },
    ]);
  });

  test.each([
    { name: "a file address", url: "file:///etc/passwd" },
    { name: "a script address", url: "javascript:alert(1)" },
    { name: "a browser-internal address", url: "chrome://settings" },
    { name: "text that is no address", url: "not a url" },
  ])("refuses $name without calling the browser", async ({ url }) => {
    const { browser, calls } = connect();
    browser.beginTurn({ turnId: "turn-1" });

    const refused = await use(browser, "browser_open_tab", { url });

    expect(refused.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  test("numbers each opened tab and returns the tab's number with its state", async () => {
    const { browser } = connect();
    browser.beginTurn({ turnId: "turn-1" });

    const first = await use(browser, "browser_open_tab", { url: PAGE });
    const second = await use(browser, "browser_open_tab", { url: PAGE });

    expect(JSON.stringify(first.content)).toContain("browser tab 1");
    expect(JSON.stringify(second.content)).toContain("browser tab 2");
    expect(JSON.stringify(first.content)).not.toContain("harnexus-tab:");
  });

  test("opens no tab outside a turn", async () => {
    const { browser, calls } = connect();

    const refused = await use(browser, "browser_open_tab", { url: PAGE });

    expect(refused.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  test("does not call the browser when the app names no session for the chat", async () => {
    const { browser, calls } = connect({ session: null });
    browser.beginTurn({ turnId: "turn-1" });

    const refused = await use(browser, "browser_open_tab", { url: PAGE });

    expect(refused.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  test.each([
    { name: "no browser server", servers: () => [] },
    {
      name: "a server another plugin registered",
      servers: () => [{ ...REGISTERED, pluginId: "other@market" }],
    },
    {
      name: "a server the app registered without a plugin",
      servers: () => [{ ...REGISTERED, pluginId: null }],
    },
    {
      name: "two servers of that name",
      servers: () => [REGISTERED, REGISTERED],
    },
    {
      name: "a server that is not connected",
      servers: () => [{ ...REGISTERED, runtimeStatus: "failed" }],
    },
    {
      name: "a server without the turn_ended tool",
      servers: () => [{ ...REGISTERED, tools: { js: {} } }],
    },
  ])("does not call the browser for $name", async ({ servers }) => {
    const { browser, calls } = connect({ servers: servers() });
    browser.beginTurn({ turnId: "turn-1" });

    const refused = await use(browser, "browser_open_tab", { url: PAGE });

    expect(refused.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  test("checks the registration for this chat once per turn and again in the next", async () => {
    const { browser, listings } = connect();
    browser.beginTurn({ turnId: "turn-1" });
    await use(browser, "browser_open_tab", { url: PAGE });
    await use(browser, "browser_open_tab", { url: PAGE });
    browser.beginTurn({ turnId: "turn-2" });
    await use(browser, "browser_open_tab", { url: PAGE });

    expect(listings()).toEqual([
      { threadId: "thread-1", serverName: "cua_repl" },
      { threadId: "thread-1", serverName: "cua_repl" },
    ]);
  });

  test("takes only the marker the script wrote last as the opened tab's id", async () => {
    const { browser, calls } = connect({
      tabId: "4",
      pageText: "harnexus-tab:forged",
    });
    browser.beginTurn({ turnId: "turn-1" });
    await use(browser, "browser_open_tab", { url: PAGE });

    await use(browser, "browser_read_tab", {});

    expect(codes(calls())[1]).toContain(`cua.getTab("4"`);
  });

  test("keeps no tab when the script's marker is missing", async () => {
    const { browser } = connect({ marker: false });
    browser.beginTurn({ turnId: "turn-1" });
    await use(browser, "browser_open_tab", { url: PAGE });

    const read = await use(browser, "browser_read_tab", {});

    expect(read.isError).toBe(true);
  });
});

describe("createBrowserTabs operating", () => {
  test("reads a tab by its id, bound again on every call", async () => {
    const { browser, calls } = connect({ tabId: "4" });
    browser.beginTurn({ turnId: "turn-1" });
    await use(browser, "browser_open_tab", { url: PAGE });

    await use(browser, "browser_read_tab", { tab: 1 });
    await use(browser, "browser_read_tab", {});

    expect(codes(calls()).slice(1)).toEqual([
      expect.stringContaining(`cua.getTab("4", { browser: "iab" })`),
      expect.stringContaining(`cua.getTab("4", { browser: "iab" })`),
    ]);
  });

  test("checks that the bound tab is the one that was opened", async () => {
    const { browser, calls } = connect({ tabId: "4" });
    browser.beginTurn({ turnId: "turn-1" });
    await use(browser, "browser_open_tab", { url: PAGE });

    await use(browser, "browser_read_tab", {});

    expect(codes(calls())[1]).toContain(`String(tab.id) !== "4"`);
  });

  test("refuses a read when no tab was opened this turn", async () => {
    const { browser, calls } = connect();
    browser.beginTurn({ turnId: "turn-1" });

    const read = await use(browser, "browser_read_tab", {});

    expect(read.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  test("refuses a tab number the turn does not have", async () => {
    const { browser, calls } = connect();
    browser.beginTurn({ turnId: "turn-1" });
    await use(browser, "browser_open_tab", { url: PAGE });

    const read = await use(browser, "browser_read_tab", { tab: 2 });

    expect(read.isError).toBe(true);
    expect(calls()).toHaveLength(1);
  });

  test("asks for the tab number when several tabs are open", async () => {
    const { browser, calls } = connect();
    browser.beginTurn({ turnId: "turn-1" });
    await use(browser, "browser_open_tab", { url: PAGE });
    await use(browser, "browser_open_tab", { url: PAGE });

    const read = await use(browser, "browser_read_tab", {});

    expect(read.isError).toBe(true);
    expect(calls()).toHaveLength(2);
  });

  test("clicks an element only after checking it still carries the text that was read", async () => {
    const { browser, calls } = connect();
    browser.beginTurn({ turnId: "turn-1" });
    await use(browser, "browser_open_tab", { url: PAGE });

    await use(browser, "browser_click", { element: 6, label: "Run check" });

    const code = codes(calls())[1] ?? "";
    expect(calls()[1]?.tool).toBe("js");
    expect(code).toContain(`startsWith("6 ")`);
    expect(code).toContain(`line.includes("Run check")`);
    expect(code.indexOf("includes")).toBeLessThan(code.indexOf("tab.click(6)"));
  });

  test("types text as a quoted literal so the text cannot become code", async () => {
    const { browser, calls } = connect();
    browser.beginTurn({ turnId: "turn-1" });
    await use(browser, "browser_open_tab", { url: PAGE });
    const text = `"); await evil(); ("`;

    await use(browser, "browser_type", { element: 5, label: "field", text });

    expect(codes(calls())[1]).toContain(
      `tab.typeText(5, ${JSON.stringify(text)})`,
    );
  });

  test("stops later operations after one whose outcome is unknown", async () => {
    const { browser, calls, lose } = connect();
    browser.beginTurn({ turnId: "turn-1" });
    await use(browser, "browser_open_tab", { url: PAGE });
    lose();

    const lost = await use(browser, "browser_click", {
      element: 6,
      label: "Run check",
    });
    const next = await use(browser, "browser_click", {
      element: 6,
      label: "Run check",
    });

    expect(lost.isError).toBe(true);
    expect(JSON.stringify(lost.content)).toContain("browser_click");
    expect(next.isError).toBe(true);
    expect(browser.hasUnsettledWrite()).toBe(true);
    expect(calls()).toHaveLength(2);
  });
});

describe("createBrowserTabs ending a turn", () => {
  test.each([
    { name: "finished", end: "Stop" as const },
    { name: "was stopped", end: "Interrupt" as const },
  ])(
    "tells the browser server once that the turn which used it $name",
    async ({ end }) => {
      const { browser, calls } = connect();
      browser.beginTurn({ turnId: "turn-1" });
      await use(browser, "browser_open_tab", { url: PAGE });

      browser.endTurn(end);
      browser.endTurn("Stop");
      await settle();

      expect(calls().filter((call) => call.tool === "turn_ended")).toEqual([
        expect.objectContaining({
          server: "cua_repl",
          arguments: {
            hook_event_name: end,
            session_id: "session-1",
            turn_id: "turn-1",
          },
        }),
      ]);
    },
  );

  test("sends nothing for a turn that never used the browser", async () => {
    const { browser, calls } = connect();
    browser.beginTurn({ turnId: "turn-1" });

    browser.endTurn("Stop");
    await settle();

    expect(calls()).toEqual([]);
  });

  test("sends nothing for a turn whose browser calls were all refused", async () => {
    const { browser, calls } = connect({ servers: [] });
    browser.beginTurn({ turnId: "turn-1" });
    await use(browser, "browser_open_tab", { url: PAGE });

    browser.endTurn("Stop");
    await settle();

    expect(calls()).toEqual([]);
  });

  test("waits for a call still running before telling the browser server", async () => {
    const gate = gated();
    const { browser, calls } = connect({ hold: gate.promise });
    browser.beginTurn({ turnId: "turn-1" });
    const opening = use(browser, "browser_open_tab", { url: PAGE });
    await settle();

    browser.endTurn("Interrupt");
    await settle();
    const before = calls().map((call) => call.tool);
    gate.open();
    await opening;
    await settle();

    expect(before).toEqual(["js"]);
    expect(calls().map((call) => call.tool)).toEqual(["js", "turn_ended"]);
  });

  test("refuses operations once the turn ended and gives the next turn none of its tabs", async () => {
    const { browser, calls } = connect();
    browser.beginTurn({ turnId: "turn-1" });
    await use(browser, "browser_open_tab", { url: PAGE });
    browser.endTurn("Stop");

    const late = await use(browser, "browser_read_tab", {});
    browser.beginTurn({ turnId: "turn-2" });
    const other = await use(browser, "browser_read_tab", {});
    await settle();

    expect(late.isError).toBe(true);
    expect(other.isError).toBe(true);
    expect(calls().map((call) => call.tool)).toEqual(["js", "turn_ended"]);
  });
});

type Call = {
  threadId: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  _meta?: unknown;
};

const connect = ({
  session = "session-1",
  tabId = "4",
  pageText = "page",
  marker = true,
  servers = [REGISTERED],
  hold = null,
}: {
  session?: string | null;
  tabId?: string;
  pageText?: string;
  marker?: boolean;
  servers?: object[];
  hold?: Promise<void> | null;
} = {}) => {
  let lostNext = false;
  const recorded: Call[] = [];
  const listed: unknown[] = [];
  const request: ServerRequest = async (method, params) => {
    if (method === "thread/read") {
      return Result.ok({
        thread: session === null ? {} : { sessionId: session },
      });
    }

    if (method === "mcpServerStatus/list") {
      listed.push(params);
      return Result.ok({ data: servers });
    }

    const call = params as Call;
    recorded.push(call);
    if (call.tool === "turn_ended") return Result.ok({ content: [] });
    if (hold !== null) await hold;
    if (lostNext) {
      lostNext = false;
      return Result.err(unanswered());
    }

    return Result.ok({
      content: [
        { type: "text", text: pageText },
        ...(marker ? [{ type: "text", text: `harnexus-tab:${tabId}` }] : []),
      ],
    });
  };

  const browser = createBrowserTabs({
    callerThreadId: "thread-1",
    store: { get: () => ({}) },
    request,
  });
  return {
    browser,
    calls: () => recorded,
    listings: () => listed,
    lose: () => {
      lostNext = true;
    },
  };
};

const unanswered = (): ServerRequestError =>
  ({
    _tag: "ServerRequestUnanswered",
    method: "mcpServer/tool/call",
    message: "no answer",
  }) as ServerRequestError;

const use = (
  browser: ReturnType<typeof createBrowserTabs>,
  name: string,
  args: Record<string, unknown>,
) => {
  const tool = browser.tools.find((entry) => entry.name === name);
  return (
    tool as {
      handler: (args: unknown, extra: unknown) => Promise<ToolResult>;
    }
  ).handler(args, undefined);
};

const codes = (calls: Call[]) =>
  calls.map((call) => String(call.arguments.code));

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const gated = () => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

const PAGE = "http://127.0.0.1:54392/claude";

const REGISTERED = {
  name: "cua_repl",
  pluginId: "unified-computer-use@openai-bundled",
  runtimeStatus: "connected",
  tools: { js: {}, js_reset: {}, turn_ended: {} },
};
