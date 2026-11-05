export type TabMention = {
  // The exact reference the app wrote, which the browser plugin validates itself when the tab is bound.
  link: string;
  browserId: string;
  tabId: string;
  title: string;
  url: string;
};

// Reads the in-app browser tab reference the app attaches to a message; anything not written in the app's own form is not a reference.
export const parseTabMention = (value: unknown): TabMention | null => {
  if (typeof value !== "string" || value.length > MAX_LINK_CHARS) return null;
  if (!value.startsWith(PREFIX)) return null;

  const query = new URLSearchParams(value.slice(PREFIX.length));
  const keys = [...query.keys()];
  if (keys.length !== KEYS.length || keys.some((key, i) => key !== KEYS[i])) {
    return null;
  }

  const browserId = query.get("browserId");
  const tabId = query.get("tabId");
  const title = query.get("title");
  const url = query.get("url");
  if (
    query.get("mention") !== VERSION ||
    !isIdentifier(browserId) ||
    !isIdentifier(tabId) ||
    title === null ||
    url === null
  ) {
    return null;
  }

  // Re-serializing must give back the same text, so a hand-edited or differently encoded link is refused.
  return serialize({ browserId, tabId, title, url }) === value
    ? { link: value, browserId, tabId, title, url }
    : null;
};

const serialize = (tab: Omit<TabMention, "link">) => {
  const query = new URLSearchParams();
  query.set("mention", VERSION);
  query.set("browserId", tab.browserId);
  query.set("tabId", tab.tabId);
  query.set("title", tab.title);
  query.set("url", tab.url);
  return `${PREFIX}${query.toString()}`;
};

const isIdentifier = (value: string | null): value is string =>
  value !== null &&
  value.trim() !== "" &&
  value.length <= MAX_ID_CHARS &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/.test(value);

const PREFIX = "plugin://browser@openai-bundled?";
const VERSION = "tab-v1";
const KEYS = ["mention", "browserId", "tabId", "title", "url"];
const MAX_ID_CHARS = 512;
const MAX_LINK_CHARS = 16_384;
