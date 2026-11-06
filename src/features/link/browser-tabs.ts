import { Result } from "better-result";
import { z } from "zod";

import type { TabMention } from "../../infra/codex/protocol/tab-mention.ts";
import type { ServerRequest } from "../../infra/codex/server-requests.ts";
import { isObject } from "../../lib/object.ts";
import {
  CALL_TIMEOUT_MS,
  createAppToolCalls,
  type LinkStore,
  MetaUnavailable,
} from "./calls.ts";
import { defineTool, failure, type ToolResult } from "./results.ts";

export type BrowserTurn = {
  turnId: string;
  // The tabs the user's message linked; none is used before the user allows it.
  candidates: readonly TabMention[];
  confirm: (
    tab: Pick<TabMention, "title" | "url">,
    signal: AbortSignal,
  ) => Promise<boolean>;
};

type ActiveTurn = {
  turnId: string;
  tabs: string[];
  candidates: readonly TabMention[];
  confirm: BrowserTurn["confirm"];
  // Each candidate is asked about once, so a refusal or a repeated call never asks the user again.
  decisions: Map<number, Promise<boolean>>;
  ended: AbortController;
  // Set once a call is about to reach the browser server, so only a turn that used it is reported as ended.
  used: boolean;
  registered: boolean;
};

export type TurnEnd = "Stop" | "Interrupt";

// Fixed in-app browser operations for one Claude thread, run through the Codex app's own browser server for the running turn.
export const createBrowserTabs = ({
  callerThreadId,
  store,
  request,
}: {
  // The Claude thread the bridge started this for, never a value the model supplies.
  callerThreadId: string;
  store: LinkStore;
  request: ServerRequest;
}) => {
  let turn: ActiveTurn | null = null;
  let sessionId: string | null = null;
  const inFlight = new Set<Promise<unknown>>();

  const sessionOf = async () => {
    if (sessionId !== null) return sessionId;
    const read = await request(
      "thread/read",
      { threadId: callerThreadId, includeTurns: false },
      { timeoutMs: CALL_TIMEOUT_MS },
    );
    const thread =
      read.isOk() && isObject(read.value) ? read.value.thread : null;
    const id = isObject(thread) ? thread.sessionId : null;
    if (typeof id === "string" && id !== "") sessionId = id;
    return sessionId;
  };

  const metaOf = async (turnId: string) => {
    // The app learns which chat and turn a browser call acts for from this meta, so it is built from what the bridge knows and never from tool input.
    const session = await sessionOf();
    return session === null
      ? Result.err(
          new MetaUnavailable({
            message:
              "The Codex app did not say which session this chat belongs to, so the browser was not used.",
          }),
        )
      : Result.ok({
          "x-codex-turn-metadata": {
            session_id: session,
            thread_id: callerThreadId,
            turn_id: turnId,
            thread_source: "user",
          },
        });
  };

  const verifyRegistration = async (running: ActiveTurn) => {
    // A server of the same name that the app did not register would receive the turn's browser calls, so the call goes only to the one registration the app made for this chat.
    if (running.registered) return Result.ok();
    const listed = await request(
      "mcpServerStatus/list",
      { threadId: callerThreadId, serverName: SERVER },
      { timeoutMs: CALL_TIMEOUT_MS },
    );
    const data: unknown[] =
      listed.isOk() &&
      isObject(listed.value) &&
      Array.isArray(listed.value.data)
        ? (listed.value.data as unknown[])
        : [];
    const entries = data.filter(
      (entry) => isObject(entry) && entry.name === SERVER,
    );
    const entry = entries[0];
    const tools =
      isObject(entry) && isObject(entry.tools) ? Object.keys(entry.tools) : [];
    if (
      entries.length !== 1 ||
      !isObject(entry) ||
      entry.pluginId !== APP_PLUGIN ||
      entry.runtimeStatus !== "connected" ||
      !REQUIRED_TOOLS.every((tool) => tools.includes(tool))
    ) {
      return Result.err(
        new MetaUnavailable({
          message:
            "The Codex app has no browser server registered for this chat, so the browser was not used.",
        }),
      );
    }

    running.registered = true;
    return Result.ok();
  };

  const calls = createAppToolCalls({
    callerThreadId,
    store,
    request,
    target: {
      server: SERVER,
      meta: async () => {
        const running = turn;
        if (running === null) return notRunning();
        const checked = await verifyRegistration(running);
        if (checked.isErr()) return checked;
        const meta = await metaOf(running.turnId);
        if (turn !== running) return notRunning();
        running.used = meta.isOk() || running.used;
        return meta.isErr()
          ? meta
          : Result.ok({ meta: meta.value, signal: running.ended.signal });
      },
    },
    unknownAdvice:
      "Stop using the browser and tell the user what may have happened, so they can check the tab.",
  });

  const execute = (
    running: ActiveTurn,
    mode: "read" | "write",
    { label, title, code }: Script,
  ) => {
    const args = { code, title };
    const operation =
      mode === "read"
        ? calls.read("js", args, [], CALL_TIMEOUT_MS)
        : calls.write("js", args, [], { label });
    inFlight.add(operation);
    const forget = () => inFlight.delete(operation);
    operation.then(forget, forget);
    return operation;
  };

  const operate = async (
    mode: "read" | "write",
    number: number | undefined,
    script: (tabId: string) => Script,
  ): Promise<ToolResult> => {
    const running = turn;
    if (running === null) return failure(NO_TURN);
    const tabId = pickTab(running, number);
    return tabId.isErr()
      ? failure(tabId.error)
      : execute(running, mode, script(tabId.value));
  };

  const consent = (running: ActiveTurn, number: number, tab: TabMention) => {
    const decided = running.decisions.get(number);
    if (decided !== undefined) return decided;
    const asked = running.confirm(tab, running.ended.signal);
    running.decisions.set(number, asked);
    return asked;
  };

  const tools = [
    defineTool(
      "browser_open_tab",
      "Open a web page in the Codex in-app browser. The new tab is numbered after the tabs this turn already opened, and its state is returned; the browser can only operate tabs opened this way during the turn. Only http and https pages open. The tab closes when the turn ends; set keepOpen only when the work must continue in a later turn, and if keeping it cannot be confirmed the tab is still open and numbered, so never open the page again.",
      { url: z.string().min(1), keepOpen: z.boolean().optional() },
      async (args) => {
        const url = openableUrl(args.url);
        if (url === null) {
          return failure("Only http and https pages can be opened.");
        }

        const running = turn;
        if (running === null) return failure(NO_TURN);
        const opened = await execute(running, "write", {
          label: "browser_open_tab",
          title: "Opening a browser tab",
          code: openScript(url, args.keepOpen === true),
        });
        const marked = takeMarker(opened);
        if (opened.isError === true || marked.id === null) return marked.result;

        // Only a tab this turn opened itself joins the turn's tabs, so a tab number always names a tab the turn may operate.
        running.tabs.push(marked.id);
        return withNumber(marked.result, running.tabs.length);
      },
    ),
    defineTool(
      "browser_use_attached_tab",
      "Use an in-app browser tab the user's message linked, by its candidate number from <browser_tab_candidates>. The user is asked to allow it first; if they refuse, do not retry. The tab is then numbered after the tabs this turn already has, and its state is returned. Set keepOpen only when the work must continue in a later turn; if keeping it cannot be confirmed the tab is still open, so do not use the link again.",
      {
        candidate: z.number().int().positive(),
        keepOpen: z.boolean().optional(),
      },
      async (args) => {
        const running = turn;
        if (running === null) return failure(NO_TURN);
        const tab = running.candidates[args.candidate - 1];
        if (tab === undefined) {
          return failure(
            `There is no candidate ${args.candidate}; the message linked ${running.candidates.length}.`,
          );
        }

        const session = await sessionOf();
        if (session === null || tab.browserId !== session) {
          return failure(
            "That tab belongs to another chat, so it was not used.",
          );
        }

        const allowed = await consent(running, args.candidate, tab);
        // The turn may have ended or moved on while the user was asked, and an answer allows the tab for its own turn only.
        if (turn !== running) return failure(NO_TURN);
        if (!allowed) {
          return failure(
            "The user did not allow this tab, so it was not used.",
          );
        }

        const resolved = await execute(
          running,
          args.keepOpen === true ? "write" : "read",
          {
            label: "browser_use_attached_tab",
            title: "Opening the attached browser tab",
            code: attachedScript(tab, args.keepOpen === true),
          },
        );
        const marked = takeMarker(resolved);
        if (resolved.isError === true || marked.id === null)
          return marked.result;
        const known = running.tabs.indexOf(marked.id);
        if (known >= 0) {
          return failure(
            `That tab is already browser tab ${known + 1} of this turn.`,
          );
        }

        running.tabs.push(marked.id);
        return withNumber(marked.result, running.tabs.length);
      },
    ),
    defineTool(
      "browser_read_tab",
      "Read the current state of a browser tab of this turn: its elements with their numbers, for browser_click and browser_type.",
      { tab: TAB_NUMBER },
      (args) =>
        operate("read", args.tab, (tabId) => ({
          label: "browser_read_tab",
          title: "Reading the browser tab",
          code: tabScript(tabId, ""),
        })),
      { annotations: { readOnlyHint: true } },
    ),
    defineTool(
      "browser_click",
      "Click an element of a browser tab by its number and its whole line from the latest browser_read_tab, then return the tab's new state. It clicks only if that line is unchanged, so read the tab again after the page changes.",
      { tab: TAB_NUMBER, element: ELEMENT, row: ELEMENT_ROW },
      (args) =>
        operate("write", args.tab, (tabId) => ({
          label: "browser_click",
          title: "Clicking in the browser tab",
          code: tabScript(
            tabId,
            `${elementGuard(args.element, args.row)}\n  await tab.click(${args.element});\n  await tab.getAXState();`,
          ),
        })),
    ),
    defineTool(
      "browser_type",
      "Type text into an element of a browser tab by its number and its whole line from the latest browser_read_tab, then return the tab's new state. It types only if that line is unchanged.",
      {
        tab: TAB_NUMBER,
        element: ELEMENT,
        row: ELEMENT_ROW,
        text: z.string(),
      },
      (args) =>
        operate("write", args.tab, (tabId) => ({
          label: "browser_type",
          title: "Typing in the browser tab",
          code: tabScript(
            tabId,
            `${elementGuard(args.element, args.row)}\n  await tab.typeText(${args.element}, ${JSON.stringify(args.text)});\n  await tab.getAXState();`,
          ),
        })),
    ),
  ];

  const sendTurnEnded = async (turnId: string, end: TurnEnd) => {
    const meta = await metaOf(turnId);
    if (meta.isErr()) return;
    await request(
      "mcpServer/tool/call",
      {
        threadId: callerThreadId,
        server: SERVER,
        tool: "turn_ended",
        arguments: {
          hook_event_name: end,
          session_id: meta.value["x-codex-turn-metadata"].session_id,
          turn_id: turnId,
        },
        _meta: meta.value,
      },
      { timeoutMs: CALL_TIMEOUT_MS },
    );
  };

  const settled = async () => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  };

  const endTurn = (end: TurnEnd) => {
    // The turn loses the browser at once, and the browser server hears of the end once, after the calls still running have settled, so none of its tabs carries into the next turn.
    const ending = turn;
    turn = null;
    // A question still open when the turn ends is withdrawn, so no later answer can allow anything.
    ending?.ended.abort();
    calls.stopWrites();
    if (ending === null || !ending.used) return;
    void settled().then(() => sendTurnEnded(ending.turnId, end));
  };

  return {
    tools,
    beginTurn: ({ turnId, candidates, confirm }: BrowserTurn) => {
      endTurn("Stop");
      calls.acceptWrites();
      turn = {
        turnId,
        tabs: [],
        candidates,
        confirm,
        decisions: new Map(),
        ended: new AbortController(),
        used: false,
        registered: false,
      };
    },
    endTurn,
    hasUnsettledWrite: calls.hasUnsettledWrite,
  };
};

type Script = { label: string; title: string; code: string };

const notRunning = () => Result.err(new MetaUnavailable({ message: NO_TURN }));

const pickTab = (turn: ActiveTurn, number: number | undefined) => {
  if (turn.tabs.length === 0) {
    return Result.err(
      "No browser tab is open in this turn. Open one with browser_open_tab.",
    );
  }

  if (number === undefined) {
    const only = turn.tabs[0];
    return turn.tabs.length === 1 && only !== undefined
      ? Result.ok(only)
      : Result.err(
          `Several tabs are open; pass the tab number, 1 to ${turn.tabs.length}.`,
        );
  }

  const tabId = turn.tabs[number - 1];
  return tabId === undefined
    ? Result.err(
        `There is no tab ${number}; this turn opened ${turn.tabs.length}.`,
      )
    : Result.ok(tabId);
};

const tabScript = (tabId: string, action: string) => {
  // The tab is bound again on every call and must be the one that was opened, so a tab that closed or was swapped is an error rather than a stale handle.
  const id = JSON.stringify(tabId);
  return [
    "{",
    `  const tab = await cua.getTab(${id}, { browser: "iab" });`,
    `  if (String(tab.id) !== ${id}) throw new Error("The tab is no longer the one this turn opened.");`,
    ...(action === "" ? [] : [`  ${action}`]),
    "}",
  ].join("\n");
};

const elementGuard = (element: number, row: string) => {
  // Element numbers come from an earlier read and shift with the page, so the action runs only if the element's whole line is still what the model read.
  const whole = JSON.stringify(`${element} ${row.trim()}`);
  return [
    "const state = await tab.getAXState({ disableDiffing: true, emit: false });",
    `  const line = state.split("\\n").find((entry) => entry.trim().startsWith(${JSON.stringify(`${element} `)}));`,
    `  if (line === undefined || line.trim() !== ${whole}) throw new Error("Element ${element} is no longer the one that was read; read the tab again.");`,
  ].join("\n");
};

const openScript = (url: string, keepOpen: boolean) =>
  [
    "{",
    `  const tab = await cua.createBrowserTab("iab", ${JSON.stringify(url)}, { visible: true });`,
    ...keepScript(keepOpen),
    `  nodeRepl.write(${JSON.stringify(TAB_MARKER)} + tab.id);`,
    "}",
  ].join("\n");

// The tab is already open when keeping it fails, so the failure is reported in a fixed sentence and the tab stays numbered, and nothing opens it again.
const keepScript = (keepOpen: boolean) =>
  keepOpen
    ? [
        "  try {",
        "    await tab.markHandoff();",
        "  } catch {",
        `    nodeRepl.write(${JSON.stringify(KEEP_UNCONFIRMED)});`,
        "  }",
      ]
    : [];

const attachedScript = (tab: TabMention, keepOpen: boolean) =>
  // The app's own binding checks the tab's id, title and address against the link, so a tab that changed since the user attached it is an error.
  [
    "{",
    `  const tab = await cua.getTab({ mention: ${JSON.stringify(tab.link)} }, { browser: "iab" });`,
    ...keepScript(keepOpen),
    `  nodeRepl.write(${JSON.stringify(TAB_MARKER)} + tab.id);`,
    "}",
  ].join("\n");

const openableUrl = (value: string) => {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:"
    ? url.href
    : null;
};

const takeMarker = (result: ToolResult) => {
  // The marker is the last thing the script writes, so a page cannot forge one: only a marker in the last text item counts.
  const last = result.content.at(-1);
  if (last === undefined || last.type !== "text") return { id: null, result };
  const lines = last.text.split("\n");
  const index = lines
    .map((line) => line.startsWith(TAB_MARKER))
    .lastIndexOf(true);
  const id = (lines[index] ?? "").slice(TAB_MARKER.length);
  if (index < 0 || !TAB_ID.test(id)) return { id: null, result };
  const text = lines.filter((_, at) => at !== index).join("\n");
  const kept = text === "" ? [] : [{ type: "text" as const, text }];
  return {
    id,
    result: { ...result, content: [...result.content.slice(0, -1), ...kept] },
  };
};

const withNumber = (result: ToolResult, number: number): ToolResult => ({
  ...result,
  content: [
    { type: "text", text: `Opened as browser tab ${number}.` },
    ...result.content,
  ],
});

const SERVER = "cua_repl";
// Reading a tab the turn already holds needs no question, and the attached-tab tool asks the user itself, so Claude's own permission prompt, which its auto mode could answer, stands in for neither.
export const BROWSER_ALLOWED_TOOLS = [
  "browser_read_tab",
  "browser_use_attached_tab",
];
const APP_PLUGIN = "unified-computer-use@openai-bundled";
const REQUIRED_TOOLS = ["js", "turn_ended"];
const TAB_MARKER = "harnexus-tab:";
const KEEP_UNCONFIRMED =
  "Keeping this tab open for a later turn could not be confirmed. The tab is open and numbered; do not open it again.";
const TAB_ID = /^[\w.:-]{1,200}$/;
const NO_TURN = "The browser can be used only while a turn is running.";
const TAB_NUMBER = z.number().int().positive().optional();
const ELEMENT = z.number().int().nonnegative();
const ELEMENT_ROW = z
  .string()
  .min(1)
  .describe(
    "Everything after the element number on its line in the latest browser_read_tab, such as 'button Run check'",
  );
