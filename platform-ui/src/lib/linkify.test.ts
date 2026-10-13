import { describe, it, expect } from "vitest";
import { linkify } from "./linkify";

// Merged from conversation.test.ts (splitLinks) and portalConversation.test.ts (linkifyText): one helper, every case.
describe("linkify: plain text in, data out", () => {
  it("makes http and https links and leaves the rest as text, trailing punctuation outside", () => {
    expect(linkify("See https://example.com/a?b=1, then reply.")).toEqual([
      { type: "text", value: "See " },
      { type: "link", value: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { type: "text", value: ", then reply." },
    ]);
  });
  it("never makes a link from a javascript: or data: URL", () => {
    expect(linkify("javascript:alert(1) data:text/html,<b>x</b>")).toEqual([{ type: "text", value: "javascript:alert(1) data:text/html,<b>x</b>" }]);
  });
  it("never links a non-http scheme", () => {
    expect(linkify("javascript:alert(1) and ftp://x.test")).toEqual([{ type: "text", value: "javascript:alert(1) and ftp://x.test" }]);
  });
  it("keeps markup characters as text parts (an <img onerror> stays literal)", () => {
    expect(linkify('<img src=x onerror="alert(1)">')).toEqual([{ type: "text", value: '<img src=x onerror="alert(1)">' }]);
  });
  it("keeps a closing bracket or brace outside the link", () => {
    expect(linkify("(see https://example.com/x)")).toEqual([
      { type: "text", value: "(see " },
      { type: "link", value: "https://example.com/x", href: "https://example.com/x" },
      { type: "text", value: ")" },
    ]);
  });
});
