import { describe, it, expect } from "vitest";
import {
  EXPORT_FORMATS, changedText, commentsText, connectionPath, connectionsHrefFor, createLinkPath, exportPath, exportedText,
  figmaErrorText, figmaErrorToken, linkPath, linksPath, normalizeConnection, normalizeExport, normalizeLink, normalizeLinks,
  safeFigmaHref, staleText, thumbnailSrc, tokenTypeLabel,
} from "./figma";

// DW-6k UI: the pure half. The token-to-sentence mapping, the shapes the backend sends (BFF §36.8), the route URLs, and the
// one rule the section lives by: `null` is "not read yet", never zero.

const row = (over: Record<string, unknown> = {}) => ({
  id: "l1", targetKind: "pm_task", targetId: "t1", fileKey: "abc123", nodeId: "1:2",
  url: "https://www.figma.com/design/abc123?node-id=1-2", title: "Brand / Hero", lastModified: "2026-10-14T08:00:00.000Z",
  openComments: 3, cachedAt: "2026-10-14T08:05:00.000Z", assetGroupId: null, createdBy: "u1", createdAt: "2026-10-13T00:00:00.000Z",
  stale: false, refreshError: null, ...over,
});

describe("figmaErrorText: the backend's tokens in plain sentences", () => {
  // Every token §36.8 lists, as the backend writes it: at the START of `error`, followed by its own words.
  const TOKENS = [
    "bad_figma_url", "figma_not_connected", "figma_refused", "figma_not_found", "figma_rate_limited", "figma_unavailable",
    "figma_render_failed", "export_too_large", "link_exists", "too_many_links", "link_not_found", "target_not_found",
    "bad_target", "bad_export", "bad_token", "bad_token_type",
  ];

  it("has a sentence for every token, found at the start of `error`", () => {
    for (const t of TOKENS) {
      const text = figmaErrorText({ status: 409, error: `${t}: something the server said` });
      expect(text, t).not.toContain(t); // never the machine token
      expect(text, t).not.toContain("something the server said"); // our own words, not the raw message
      expect(text.length, t).toBeGreaterThan(20);
      expect(text.endsWith("."), t).toBe(true);
    }
  });

  it("gives each token its own sentence", () => {
    const all = new Set(TOKENS.map((t) => figmaErrorText({ status: 409, error: `${t}: x` })));
    expect(all.size).toBe(TOKENS.length);
  });

  it("says what to do for the ones a person can act on", () => {
    expect(figmaErrorText({ status: 400, error: "bad_figma_url: not a Figma file link" })).toMatch(/Paste the address of a Figma file or frame/);
    expect(figmaErrorText({ status: 409, error: "figma_not_connected: no token" })).toMatch(/Tools & connections/);
    expect(figmaErrorText({ status: 409, error: "figma_refused: x" })).toMatch(/replace it/);
    expect(figmaErrorText({ status: 409, error: "link_exists: x" })).toBe("That file or frame is already linked here.");
    expect(figmaErrorText({ status: 409, error: "too_many_links: x" })).toMatch(/25/);
    expect(figmaErrorText({ status: 503, error: "figma_rate_limited: x" })).toMatch(/minute/);
  });

  it("reads the token from `reason` when the error text lost it", () => {
    expect(figmaErrorText({ status: 409, error: "reworded by someone", reason: "link_exists" })).toBe("That file or frame is already linked here.");
    expect(figmaErrorToken("x", "figma_refused")).toBe("figma_refused");
  });

  it("only takes a token that LEADS the message, never one mentioned inside it", () => {
    expect(figmaErrorToken("the link_exists case was handled")).toBeNull();
    expect(figmaErrorToken("link_exists")).toBe("link_exists");
    expect(figmaErrorToken("link_exists: x")).toBe("link_exists");
    expect(figmaErrorToken("constructor: x")).toBeNull(); // an object's own property names are not tokens
    expect(figmaErrorToken("")).toBeNull();
    expect(figmaErrorToken(undefined)).toBeNull();
  });

  it("a 403 is a calm sentence about permission, whatever the message says", () => {
    const t = figmaErrorText({ status: 403, error: "forbidden: action update on pm_task" });
    expect(t).toBe("You don't have permission to do that. Ask the item's owner or a manager.");
    expect(figmaErrorText({ status: 403, error: "figma_refused: x" })).toBe(t);
  });

  it("a 401 says the session ended", () => {
    expect(figmaErrorText({ status: 401 })).toMatch(/session expired/);
  });

  it("an unknown failure is not blamed on Figma and never prints the raw message", () => {
    const t = figmaErrorText({ status: 500, error: "TypeError: cannot read properties of undefined" });
    expect(t).not.toMatch(/TypeError/);
    expect(t).toMatch(/Try again/);
    expect(figmaErrorText({ status: 404, error: "not found" })).toMatch(/Reload/);
  });
});

describe("normalizeLink: null stays null", () => {
  it("keeps every field of a fully read link", () => {
    expect(normalizeLink(row())).toEqual({
      id: "l1", targetKind: "pm_task", targetId: "t1", fileKey: "abc123", nodeId: "1:2",
      url: "https://www.figma.com/design/abc123?node-id=1-2", title: "Brand / Hero", lastModified: "2026-10-14T08:00:00.000Z",
      openComments: 3, cachedAt: "2026-10-14T08:05:00.000Z", assetGroupId: null, stale: false, refreshError: null,
    });
  });

  it("keeps a link that was never read as nulls, never as zero or an empty string", () => {
    const l = normalizeLink(row({ title: null, lastModified: null, openComments: null, cachedAt: null }))!;
    expect(l.openComments).toBeNull();
    expect(l.title).toBeNull();
    expect(l.lastModified).toBeNull();
    expect(l.cachedAt).toBeNull();
  });

  it("keeps a real zero as zero", () => {
    expect(normalizeLink(row({ openComments: 0 }))!.openComments).toBe(0);
  });

  it("treats a malformed count as not read", () => {
    for (const bad of ["3", -1, 1.5, NaN, undefined, {}]) expect(normalizeLink(row({ openComments: bad }))!.openComments).toBeNull();
  });

  it("refuses a row with no id, no url or an unknown target kind", () => {
    expect(normalizeLink(row({ id: undefined }))).toBeNull();
    expect(normalizeLink(row({ url: "" }))).toBeNull();
    expect(normalizeLink(row({ targetKind: "invoice" }))).toBeNull();
    expect(normalizeLink(null)).toBeNull();
    expect(normalizeLink("x")).toBeNull();
  });

  it("carries stale and why", () => {
    const l = normalizeLink(row({ stale: true, refreshError: "figma_rate_limited" }))!;
    expect(l.stale).toBe(true);
    expect(l.refreshError).toBe("figma_rate_limited");
  });
});

describe("normalizeLinks / normalizeConnection / normalizeExport", () => {
  it("reads the list answer", () => {
    const l = normalizeLinks({ figmaConnected: false, items: [row(), row({ id: "l2" })] })!;
    expect(l.figmaConnected).toBe(false);
    expect(l.items.map((i) => i.id)).toEqual(["l1", "l2"]);
  });

  it("an empty list is an answer only when the server said whether Figma is connected", () => {
    expect(normalizeLinks({ figmaConnected: true, items: [] })).toEqual({ figmaConnected: true, items: [] });
    expect(normalizeLinks({ items: [] })).toBeNull();
    expect(normalizeLinks([])).toBeNull();
    expect(normalizeLinks({ figmaConnected: "yes", items: [] })).toBeNull();
    expect(normalizeLinks({ figmaConnected: true })).toBeNull();
  });

  it("drops a row that is not a link without dropping the rest", () => {
    expect(normalizeLinks({ figmaConnected: true, items: [row(), { nope: 1 }] })!.items).toHaveLength(1);
  });

  it("reads the connection status, with a token type only when connected", () => {
    expect(normalizeConnection({ connected: true, tokenType: "oauth" })).toEqual({ connected: true, tokenType: "oauth" });
    expect(normalizeConnection({ connected: false, tokenType: "pat" })).toEqual({ connected: false, tokenType: null });
    expect(normalizeConnection({ connected: true, tokenType: "weird" })).toEqual({ connected: true, tokenType: null });
    expect(normalizeConnection({ tokenType: "pat" })).toBeNull();
  });

  it("reads an export answer and refuses a half of one", () => {
    const out = { linkId: "l1", assetId: "a1", assetGroupId: "g1", versionNo: 2, name: "Hero.png", contentType: "image/png", byteSize: 10 };
    expect(normalizeExport(out)).toEqual({ linkId: "l1", assetId: "a1", assetGroupId: "g1", versionNo: 2, name: "Hero.png", contentType: "image/png" });
    expect(normalizeExport({ ...out, versionNo: undefined })).toBeNull();
    expect(normalizeExport({ ...out, assetId: "" })).toBeNull();
  });
});

describe("the readers' URLs", () => {
  it("builds the list read with the target kind and id, encoded", () => {
    expect(linksPath("co-1", "pm_task", "t 1")).toBe("/api/co-1/figma-links?targetKind=pm_task&targetId=t+1");
    expect(linksPath("co-1", "campaign_part", "p1")).toBe("/api/co-1/figma-links?targetKind=campaign_part&targetId=p1");
    expect(linksPath("co-1", "work_request", "r1")).toContain("targetKind=work_request");
  });

  it("builds the write, delete, export and connection routes", () => {
    expect(createLinkPath("co-1")).toBe("/api/co-1/figma-links");
    expect(linkPath("co-1", "l/1")).toBe("/api/co-1/figma-links/l%2F1");
    expect(exportPath("co-1", "l1")).toBe("/api/co-1/figma-links/l1/export");
    expect(connectionPath("co-1")).toBe("/api/co-1/integrations/figma");
  });

  it("points the thumbnail at platform-ui's own proxy route, not at Figma or the platform", () => {
    expect(thumbnailSrc("l1")).toBe("/api/figma-links/l1/thumbnail");
    expect(thumbnailSrc("a b")).toBe("/api/figma-links/a%20b/thumbnail");
  });
});

describe("words", () => {
  it("never says 0 for a count nobody read", () => {
    expect(commentsText(null)).toBe("Comments not read yet");
    expect(commentsText(null)).not.toMatch(/0/);
    expect(commentsText(0)).toBe("No open comments");
    expect(commentsText(1)).toBe("1 open comment");
    expect(commentsText(4)).toBe("4 open comments");
  });

  it("says when it changed, relative to now", () => {
    const now = Date.parse("2026-10-14T12:00:00.000Z");
    expect(changedText("2026-10-14T11:59:50.000Z", now)).toBe("changed just now");
    expect(changedText("2026-10-14T11:15:00.000Z", now)).toBe("changed 45 minutes ago");
    expect(changedText("2026-10-14T11:00:00.000Z", now)).toBe("changed 1 hour ago");
    expect(changedText("2026-10-14T09:00:00.000Z", now)).toBe("changed 3 hours ago");
    expect(changedText("2026-10-12T12:00:00.000Z", now)).toBe("changed 2 days ago");
    expect(changedText("2026-08-14T12:00:00.000Z", now)).toBe("changed 2 months ago");
    expect(changedText("2024-10-14T12:00:00.000Z", now)).toBe("changed 2 years ago");
  });

  it("says nothing about a change time it does not have", () => {
    expect(changedText(null, Date.now())).toBeNull();
    expect(changedText("not a date", Date.now())).toBeNull();
  });

  it("names the new version in the export success line", () => {
    expect(exportedText("png", { versionNo: 2, name: "Brand / Hero.png" })).toBe("Exported as PNG: version 2 of Brand / Hero.png is in the Asset Library.");
    expect(exportedText("pdf", { versionNo: 1, name: "x.pdf" })).toContain("version 1");
    expect(EXPORT_FORMATS).toEqual(["png", "svg", "pdf"]);
  });

  it("says a stale link is stale, and why", () => {
    expect(staleText({ refreshError: "figma_rate_limited" })).toBe("Stale: these are the last values read from Figma. Figma is limiting requests.");
    expect(staleText({ refreshError: "figma_refused" })).toMatch(/^Stale:.*refused the token/);
    expect(staleText({ refreshError: null })).toMatch(/couldn't be read just now/);
  });

  it("names the token type", () => {
    expect(tokenTypeLabel("pat")).toBe("Personal access token");
    expect(tokenTypeLabel("oauth")).toBe("OAuth");
  });
});

describe("safeFigmaHref", () => {
  it("passes a normalised Figma address", () => {
    expect(safeFigmaHref("https://www.figma.com/design/abc?node-id=1-2")).toBe("https://www.figma.com/design/abc?node-id=1-2");
    expect(safeFigmaHref("https://figma.com/file/abc")).toBe("https://figma.com/file/abc");
  });
  it("refuses anything else, so a stored value can never become a javascript: or other-host link", () => {
    for (const bad of ["javascript:alert(1)", "http://www.figma.com/design/a", "https://evil.example/design/a", "https://www.figma.com.evil.example/x", "nonsense", ""]) {
      expect(safeFigmaHref(bad), bad).toBeNull();
    }
  });
});

describe("connectionsHrefFor", () => {
  const ok = (figmaConnected: boolean) => ({ kind: "ok", data: { figmaConnected } });
  it("sends a manager to the department's Tools & connections when Figma is known not to be connected", () => {
    expect(connectionsHrefFor(true, "d-1", ok(false))).toBe("/departments/d-1/connections");
  });
  it("sends nobody when connected, when the read failed, when they cannot manage, or when no department is known", () => {
    expect(connectionsHrefFor(true, "d-1", ok(true))).toBeNull();
    expect(connectionsHrefFor(true, "d-1", { kind: "unavailable" })).toBeNull();
    expect(connectionsHrefFor(true, "d-1", { kind: "forbidden" })).toBeNull();
    expect(connectionsHrefFor(false, "d-1", ok(false))).toBeNull();
    expect(connectionsHrefFor(true, null, ok(false))).toBeNull();
  });
});
