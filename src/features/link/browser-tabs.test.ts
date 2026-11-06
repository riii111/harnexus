import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

import { Result } from "better-result";

import { parseTabMention } from "../../infra/codex/protocol/tab-mention.ts";
import type {
  ServerRequest,
  ServerRequestError,
} from "../../infra/codex/server-requests.ts";
import { createBrowserTabs } from "./browser-tabs.ts";
import type { ToolResult } from "./results.ts";

describe("createBrowserTabs opening", () => {
  test("opens a page in the in-app browser with the chat's session and the turn's id", async () => {
    const { browser, calls } = connect();
    begin(browser, "turn-1");

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
    begin(browser, "turn-1");

    const refused = await use(browser, "browser_open_tab", { url });

    expect(refused.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  test("numbers each opened tab and returns the tab's number with its state", async () => {
    const { browser } = connect();
    begin(browser, "turn-1");

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
    begin(browser, "turn-1");

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
    begin(browser, "turn-1");

    const refused = await use(browser, "browser_open_tab", { url: PAGE });

    expect(refused.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  test("checks the registration for this chat once per turn and again in the next", async () => {
    const { browser, listings } = connect();
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });
    await use(browser, "browser_open_tab", { url: PAGE });
    begin(browser, "turn-2");
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
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });

    await use(browser, "browser_read_tab", {});

    expect(codes(calls())[1]).toContain(`cua.getTab("4"`);
  });

  test("keeps no tab when the script's marker is missing", async () => {
    const { browser } = connect({ marker: false });
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });

    const read = await use(browser, "browser_read_tab", {});

    expect(read.isError).toBe(true);
  });
});

describe("createBrowserTabs operating", () => {
  test("reads a tab by its id, bound again on every call", async () => {
    const { browser, calls } = connect({ tabId: "4" });
    begin(browser, "turn-1");
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
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });

    await use(browser, "browser_read_tab", {});

    expect(codes(calls())[1]).toContain(`String(tab.id) !== "4"`);
  });

  test("refuses a read when no tab was opened this turn", async () => {
    const { browser, calls } = connect();
    begin(browser, "turn-1");

    const read = await use(browser, "browser_read_tab", {});

    expect(read.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  test("refuses a tab number the turn does not have", async () => {
    const { browser, calls } = connect();
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });

    const read = await use(browser, "browser_read_tab", { tab: 2 });

    expect(read.isError).toBe(true);
    expect(calls()).toHaveLength(1);
  });

  test("asks for the tab number when several tabs are open", async () => {
    const { browser, calls } = connect();
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });
    await use(browser, "browser_open_tab", { url: PAGE });

    const read = await use(browser, "browser_read_tab", {});

    expect(read.isError).toBe(true);
    expect(calls()).toHaveLength(2);
  });

  test("clicks an element only after checking it still carries the text that was read", async () => {
    const { browser, calls } = connect();
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });

    await use(browser, "browser_click", {
      element: 6,
      row: "button Run check",
    });

    const code = codes(calls())[1] ?? "";
    expect(calls()[1]?.tool).toBe("js");
    expect(code).toContain(`startsWith("6 ")`);
    expect(code).toContain(`line.trim() !== "6 button Run check"`);
    expect(code.indexOf("includes")).toBeLessThan(code.indexOf("tab.click(6)"));
  });

  test("types text as a quoted literal so the text cannot become code", async () => {
    const { browser, calls } = connect();
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });
    const text = `"); await evil(); ("`;

    await use(browser, "browser_type", {
      element: 5,
      row: "text field (settable) Test value",
      text,
    });

    expect(codes(calls())[1]).toContain(
      `tab.typeText(5, ${JSON.stringify(text)})`,
    );
  });

  test("stops later operations after one whose outcome is unknown", async () => {
    const { browser, calls, lose } = connect();
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });
    lose();

    const lost = await use(browser, "browser_click", {
      element: 6,
      row: "button Run check",
    });
    const next = await use(browser, "browser_click", {
      element: 6,
      row: "button Run check",
    });

    expect(lost.isError).toBe(true);
    expect(JSON.stringify(lost.content)).toContain("browser_click");
    expect(next.isError).toBe(true);
    expect(browser.hasUnsettledWrite()).toBe(true);
    expect(calls()).toHaveLength(2);
  });
});

describe("createBrowserTabs attached tabs", () => {
  test("asks the user about the linked tab before the browser is touched, then binds it by its link", async () => {
    const asked: unknown[] = [];
    const { browser, calls } = connect({ tabId: "4" });
    begin(browser, "turn-1", {
      candidates: [candidate(LINK)],
      confirm: async (tab) => {
        asked.push({ tab, callsBefore: calls().length });
        return true;
      },
    });

    const used = await use(browser, "browser_use_attached_tab", {
      candidate: 1,
    });

    expect(used.isError).toBeUndefined();
    expect(asked).toEqual([
      {
        tab: expect.objectContaining({
          title: "Harnexus browser check",
          url: PAGE,
        }),
        callsBefore: 0,
      },
    ]);
    expect(codes(calls())).toEqual([
      expect.stringContaining(`{ mention: ${JSON.stringify(LINK)} }`),
    ]);
    expect(JSON.stringify(used.content)).toContain("browser tab 1");
  });

  test("operates the allowed tab by its id afterwards", async () => {
    const { browser, calls } = connect({ tabId: "4" });
    begin(browser, "turn-1", {
      candidates: [candidate(LINK)],
      confirm: async () => true,
    });
    await use(browser, "browser_use_attached_tab", { candidate: 1 });

    await use(browser, "browser_read_tab", {});

    expect(codes(calls())[1]).toContain(`cua.getTab("4", { browser: "iab" })`);
  });

  test("uses nothing and does not ask again when the user refuses", async () => {
    let asked = 0;
    const { browser, calls } = connect();
    begin(browser, "turn-1", {
      candidates: [candidate(LINK)],
      confirm: async () => {
        asked += 1;
        return false;
      },
    });

    const first = await use(browser, "browser_use_attached_tab", {
      candidate: 1,
    });
    const again = await use(browser, "browser_use_attached_tab", {
      candidate: 1,
    });
    const read = await use(browser, "browser_read_tab", {});

    expect([first.isError, again.isError, read.isError]).toEqual([
      true,
      true,
      true,
    ]);
    expect(asked).toBe(1);
    expect(calls()).toEqual([]);
  });

  test("refuses a tab linked from another chat without asking or touching the browser", async () => {
    let asked = 0;
    const { browser, calls } = connect({ session: "session-2" });
    begin(browser, "turn-1", {
      candidates: [candidate(LINK)],
      confirm: async () => {
        asked += 1;
        return true;
      },
    });

    const used = await use(browser, "browser_use_attached_tab", {
      candidate: 1,
    });

    expect(used.isError).toBe(true);
    expect(asked).toBe(0);
    expect(calls()).toEqual([]);
  });

  test("refuses a candidate number the message did not link", async () => {
    const { browser, calls } = connect();
    begin(browser, "turn-1", { candidates: [candidate(LINK)] });

    const used = await use(browser, "browser_use_attached_tab", {
      candidate: 2,
    });

    expect(used.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  test("gives the next turn neither the allowed tab nor the answer", async () => {
    const { browser, calls } = connect({ tabId: "4" });
    begin(browser, "turn-1", {
      candidates: [candidate(LINK)],
      confirm: async () => true,
    });
    await use(browser, "browser_use_attached_tab", { candidate: 1 });
    begin(browser, "turn-2");

    const read = await use(browser, "browser_read_tab", {});
    const again = await use(browser, "browser_use_attached_tab", {
      candidate: 1,
    });

    expect(read.isError).toBe(true);
    expect(again.isError).toBe(true);
    expect(calls().filter((call) => call.tool === "js")).toHaveLength(1);
  });

  test("withdraws a question still open when the turn ends, so a late answer allows nothing", async () => {
    const answer = gated();
    let signal: AbortSignal | null = null;
    const { browser, calls } = connect({ tabId: "4" });
    begin(browser, "turn-1", {
      candidates: [candidate(LINK)],
      confirm: async (_tab, aborted) => {
        signal = aborted;
        await answer.promise;
        return true;
      },
    });
    const using = use(browser, "browser_use_attached_tab", { candidate: 1 });
    await settle();

    browser.endTurn("Interrupt");
    answer.open();
    const used = await using;

    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(used.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  test("refuses a second link that resolves to a tab the turn already has", async () => {
    const other = LINK.replace("title=Harnexus", "title=Same+tab+other+title");
    const { browser } = connect({ tabId: "4" });
    begin(browser, "turn-1", {
      candidates: [candidate(LINK), candidate(other)],
      confirm: async () => true,
    });
    await use(browser, "browser_use_attached_tab", { candidate: 1 });

    const second = await use(browser, "browser_use_attached_tab", {
      candidate: 2,
    });

    expect(second.isError).toBe(true);
    expect(JSON.stringify(second.content)).toContain("already browser tab 1");
  });

  test("does not send the old turn's link under a new turn when the turn changes while the user is asked", async () => {
    const answer = gated();
    const { browser, calls } = connect({ tabId: "4" });
    begin(browser, "turn-1", {
      candidates: [candidate(LINK)],
      confirm: async () => {
        await answer.promise;
        return true;
      },
    });
    const using = use(browser, "browser_use_attached_tab", { candidate: 1 });
    await settle();

    begin(browser, "turn-2");
    answer.open();
    const used = await using;

    expect(used.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  test("binds the tab by its link and reports the id the browser gave it", async () => {
    const { browser, calls } = connect();
    begin(browser, "turn-1", {
      candidates: [candidate(LINK)],
      confirm: async () => true,
    });
    await use(browser, "browser_use_attached_tab", { candidate: 1 });
    const tab = fakeTab({ id: "tab-77" });

    await runScript(codes(calls())[0], tab);

    expect(tab.written).toEqual(["harnexus-tab:tab-77"]);
  });
});

describe("createBrowserTabs scripts run by the browser server", () => {
  test("click presses the element whose number and text match the page as the app shows it", async () => {
    const { browser, calls } = connect({ tabId: "4" });
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });
    await use(browser, "browser_click", {
      element: 6,
      row: "button Run check",
    });
    const tab = fakeTab({ id: "4" });

    await runScript(codes(calls())[1], tab);

    expect(tab.actions).toEqual(["state", "click 6", "state"]);
  });

  test("type enters the text in the element whose number and text match", async () => {
    const { browser, calls } = connect({ tabId: "4" });
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });
    await use(browser, "browser_type", {
      element: 5,
      row: "text field (settable) Test value",
      text: "hello",
    });
    const tab = fakeTab({ id: "4" });

    await runScript(codes(calls())[1], tab);

    expect(tab.actions).toEqual(["state", 'type 5 "hello"', "state"]);
  });

  test.each([
    {
      name: "the element now carries other text",
      state: AX_STATE.replace("Run check", "Reset"),
      id: "4",
    },
    {
      name: "the element's name grew longer",
      state: AX_STATE.replace("Run check", "Run destructive check"),
      id: "4",
    },
    {
      name: "the element is now disabled",
      state: AX_STATE.replace("button Run", "button (disabled) Run"),
      id: "4",
    },
    {
      name: "the element number is gone from the page",
      state: AX_STATE.replace("\t6 button Run check", ""),
      id: "4",
    },
    { name: "the bound tab is another tab", state: AX_STATE, id: "9" },
  ])("click acts on nothing when $name", async ({ state, id }) => {
    const { browser, calls } = connect({ tabId: "4" });
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });
    await use(browser, "browser_click", {
      element: 6,
      row: "button Run check",
    });
    const tab = fakeTab({ id, state });

    await expect(runScript(codes(calls())[1], tab)).rejects.toThrow();
    expect(tab.actions).not.toContain("click 6");
  });

  test.each([
    {
      name: "kept for a later turn",
      keepOpen: true,
      marks: ["handoff"] as string[],
    },
    { name: "left temporary", keepOpen: false, marks: [] as string[] },
  ])(
    "marks the opened tab only when it is $name",
    async ({ keepOpen, marks }) => {
      const { browser, calls } = connect();
      begin(browser, "turn-1");
      await use(browser, "browser_open_tab", { url: PAGE, keepOpen });
      const tab = fakeTab({ id: "12" });

      await runScript(codes(calls())[0], tab);

      expect(tab.marks).toEqual(marks);
      expect(tab.written).toEqual(["harnexus-tab:12"]);
    },
  );

  test("opens no tab as numbered when keeping it open fails", async () => {
    const { browser, calls } = connect();
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE, keepOpen: true });
    const tab = { ...fakeTab({ id: "12" }), markHandoff: undefined };

    await expect(runScript(codes(calls())[0], tab)).rejects.toThrow();
    expect(tab.written).toEqual([]);
  });

  test("open writes the marker with the new tab's id after the page state", async () => {
    const { browser, calls } = connect();
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });
    const tab = fakeTab({ id: "12" });

    await runScript(codes(calls())[0], tab);

    expect(tab.written).toEqual(["harnexus-tab:12"]);
  });
});

describe("createBrowserTabs waiting for the user", () => {
  test("sends browser calls with the thread and the turn's stop signal, so the time limit can wait for the user", async () => {
    const { browser, options } = connect();
    begin(browser, "turn-1");

    await use(browser, "browser_open_tab", { url: PAGE });

    expect(options()).toEqual([
      {
        timeoutMs: 120_000,
        threadId: "thread-1",
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  test("sends nothing for a turn that stopped while its call was being prepared, even if the next turn has begun", async () => {
    let swap = () => {};
    const { browser, calls } = connect({ onSessionRead: () => swap() });
    begin(browser, "old");
    swap = () => {
      browser.endTurn("Interrupt");
      begin(browser, "new");
    };

    const opened = await use(browser, "browser_open_tab", { url: PAGE });

    expect(opened.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  test("ends the wait without sending the call again when the turn is stopped", async () => {
    const { browser, calls } = connect({ holdUntilAbort: true });
    begin(browser, "turn-1");
    const opening = use(browser, "browser_open_tab", { url: PAGE });
    await settle();

    browser.endTurn("Interrupt");
    const opened = await opening;
    await settle();

    expect(opened.isError).toBe(true);
    expect(browser.hasUnsettledWrite()).toBe(true);
    expect(calls().map((call) => call.tool)).toEqual(["js", "turn_ended"]);
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
      begin(browser, "turn-1");
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
    begin(browser, "turn-1");

    browser.endTurn("Stop");
    await settle();

    expect(calls()).toEqual([]);
  });

  test("sends nothing for a turn whose browser calls were all refused", async () => {
    const { browser, calls } = connect({ servers: [] });
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });

    browser.endTurn("Stop");
    await settle();

    expect(calls()).toEqual([]);
  });

  test("waits for a call still running before telling the browser server", async () => {
    const gate = gated();
    const { browser, calls } = connect({ hold: gate.promise });
    begin(browser, "turn-1");
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
    begin(browser, "turn-1");
    await use(browser, "browser_open_tab", { url: PAGE });
    browser.endTurn("Stop");

    const late = await use(browser, "browser_read_tab", {});
    begin(browser, "turn-2");
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
  holdUntilAbort = false,
  onSessionRead = () => {},
}: {
  session?: string | null;
  tabId?: string;
  pageText?: string;
  marker?: boolean;
  servers?: object[];
  hold?: Promise<void> | null;
  holdUntilAbort?: boolean;
  onSessionRead?: () => void;
} = {}) => {
  let lostNext = false;
  const recorded: Call[] = [];
  const listed: unknown[] = [];
  const sentOptions: object[] = [];
  const request: ServerRequest = async (method, params, options) => {
    if (method === "thread/read") {
      onSessionRead();
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
    sentOptions.push(options);
    if (holdUntilAbort) {
      await new Promise((resolve) =>
        options.signal?.addEventListener("abort", resolve),
      );
      return Result.err(unanswered());
    }

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
    options: () => sentOptions,
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

const begin = (
  browser: ReturnType<typeof createBrowserTabs>,
  turnId: string,
  {
    candidates = [],
    confirm = async () => false,
  }: Partial<Parameters<typeof browser.beginTurn>[0]> = {},
) => browser.beginTurn({ turnId, candidates, confirm });

const PAGE = "http://127.0.0.1:54392/claude";

const LINK =
  "plugin://browser@openai-bundled?mention=tab-v1&browserId=session-1&tabId=4&title=Harnexus+browser+check&url=http%3A%2F%2F127.0.0.1%3A54392%2Fclaude";

const candidate = (link: string) => {
  const parsed = parseTabMention(link);
  return parsed as NonNullable<typeof parsed>;
};

// The page text as the app's browser returned it for the fixture page, with the element numbers it gives.
const AX_STATE = [
  "0 AXWebArea Harnexus browser check, URL: 127.0.0.1:54392/claude",
  "\t1 heading Browser check, Value: 1",
  "\t3 container",
  "\t\t5 text field (settable) Test value",
  "\t6 button Run check",
].join("\n");

const fakeTab = ({ id, state = AX_STATE }: { id: string; state?: string }) => {
  const actions: string[] = [];
  const written: string[] = [];
  const marks: string[] = [];
  const tab = {
    markHandoff: async () => {
      marks.push("handoff");
    },
    id,
    getAXState: async () => {
      actions.push("state");
      return state;
    },
    click: async (element: number) => {
      actions.push(`click ${element}`);
    },
    typeText: async (element: number, text: string) => {
      actions.push(`type ${element} ${JSON.stringify(text)}`);
    },
  };
  return { ...tab, actions, written, marks };
};

const runScript = (
  code: string | undefined,
  tab: Omit<ReturnType<typeof fakeTab>, "markHandoff"> & {
    markHandoff?: unknown;
  },
) => {
  const cua = { getTab: async () => tab, createBrowserTab: async () => tab };
  const nodeRepl = { write: (text: string) => tab.written.push(text) };
  return runInNewContext(`(async () => {${code}})()`, {
    cua,
    nodeRepl,
  }) as Promise<void>;
};

const REGISTERED = {
  name: "cua_repl",
  pluginId: "unified-computer-use@openai-bundled",
  runtimeStatus: "connected",
  tools: { js: {}, js_reset: {}, turn_ended: {} },
};
