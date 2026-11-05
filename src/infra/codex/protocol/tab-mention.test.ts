import { describe, expect, test } from "bun:test";

import { parseTabMention } from "./tab-mention.ts";

describe("parseTabMention", () => {
  test("reads the in-app browser tab the app referenced", () => {
    expect(parseTabMention(LINK)).toEqual({
      link: LINK,
      browserId: "session-1",
      tabId: "tab 7",
      title: "Run & check",
      url: "http://127.0.0.1:54392/claude?x=1",
    });
  });

  test.each([
    { name: "a non-string", value: 7 },
    { name: "another plugin", value: LINK.replace("browser@", "chrome@") },
    { name: "an extension source", value: `${LINK}&source=extension` },
    {
      name: "keys in another order",
      value:
        "plugin://browser@openai-bundled?mention=tab-v1&tabId=t&browserId=b&title=x&url=u",
    },
    { name: "another version", value: LINK.replace("tab-v1", "tab-v2") },
    { name: "a missing key", value: LINK.replace(/&title=[^&]*/, "") },
    { name: "an extra key", value: `${LINK}&extra=1` },
    { name: "an empty tab id", value: LINK.replace("tab+7", "") },
    { name: "a different encoding", value: LINK.replace("tab+7", "tab%207") },
    { name: "a control character", value: LINK.replace("tab+7", "tab%0A7") },
    { name: "surrounding text", value: `see ${LINK}` },
  ])("refuses a reference with $name", ({ value }) => {
    expect(parseTabMention(value)).toBeNull();
  });

  test("refuses a reference longer than the app writes", () => {
    const long = LINK.replace("Run+%26+check", "x".repeat(20_000));

    expect(parseTabMention(long)).toBeNull();
  });
});

const LINK =
  "plugin://browser@openai-bundled?mention=tab-v1&browserId=session-1&tabId=tab+7&title=Run+%26+check&url=http%3A%2F%2F127.0.0.1%3A54392%2Fclaude%3Fx%3D1";
