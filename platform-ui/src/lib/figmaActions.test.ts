import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-6k UI: the writes behind the Designs section and the Figma connection block. The platform's refusals are put in words;
// nothing here decides who may do what (Cerbos does). The token goes out once and never comes back.

vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [], companies: [] })) };
});

import { platformFetch, PlatformError } from "./platform";
import {
  addFigmaLinkAction, connectFigmaAction, disconnectFigmaAction, exportFigmaLinkAction, removeFigmaLinkAction,
} from "./figmaActions";

const fetchMock = vi.mocked(platformFetch);
const body = () => JSON.parse(String(fetchMock.mock.calls[0][2]?.body));
const refused = (status: number, error: string, reason?: string) => new PlatformError(status, error, undefined, undefined, reason);
const linkRow = {
  id: "l1", targetKind: "pm_task", targetId: "t1", fileKey: "k", nodeId: null, url: "https://www.figma.com/design/k",
  title: null, lastModified: null, openComments: null, cachedAt: null, assetGroupId: null, stale: true, refreshError: "figma_not_connected",
};

beforeEach(() => { fetchMock.mockReset(); });

describe("addFigmaLinkAction", () => {
  it("POSTs the target and the pasted URL (trimmed) and returns the link, unread values still null", async () => {
    fetchMock.mockResolvedValue(linkRow);
    const r = await addFigmaLinkAction("pm_task", "t1", "  https://www.figma.com/design/k  ");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/figma-links");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(body()).toEqual({ targetKind: "pm_task", targetId: "t1", url: "https://www.figma.com/design/k" });
    expect(r.ok && r.link.openComments).toBeNull();
  });

  it("shows the backend's refusal in plain words", async () => {
    fetchMock.mockRejectedValue(refused(400, "bad_figma_url: not a Figma link", "bad_figma_url"));
    const r = await addFigmaLinkAction("pm_task", "t1", "http://example.com");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/doesn't look like a Figma link/) });
  });

  it("says a duplicate is a duplicate", async () => {
    fetchMock.mockRejectedValue(refused(409, "link_exists: that file or frame is already linked here"));
    expect(await addFigmaLinkAction("pm_task", "t1", "https://www.figma.com/design/k")).toEqual({ ok: false, error: "That file or frame is already linked here." });
  });

  it("a 403 is a calm sentence, not a thrown error", async () => {
    fetchMock.mockRejectedValue(refused(403, "forbidden"));
    const r = await addFigmaLinkAction("work_request", "r1", "https://www.figma.com/design/k");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/don't have permission/);
  });

  it("never reaches the server with an empty paste or a bad kind", async () => {
    expect(await addFigmaLinkAction("pm_task", "t1", "   ")).toEqual({ ok: false, error: "Paste a Figma link first." });
    expect((await addFigmaLinkAction("invoice" as never, "t1", "https://www.figma.com/design/k")).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an answer that is not a link is a broken read, not a success", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    expect((await addFigmaLinkAction("pm_task", "t1", "https://www.figma.com/design/k")).ok).toBe(false);
  });

  it("rethrows what is not a platform refusal (a bug is not a sentence)", async () => {
    fetchMock.mockRejectedValue(new TypeError("boom"));
    await expect(addFigmaLinkAction("pm_task", "t1", "https://www.figma.com/design/k")).rejects.toThrow("boom");
  });
});

describe("removeFigmaLinkAction", () => {
  it("DELETEs the link", async () => {
    fetchMock.mockResolvedValue({ id: "l1", deleted: true });
    expect(await removeFigmaLinkAction("l1")).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/figma-links/l1");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("DELETE");
  });
  it("says a missing link in words", async () => {
    fetchMock.mockRejectedValue(refused(404, "link_not_found: figma link not found"));
    expect(await removeFigmaLinkAction("l1")).toEqual({ ok: false, error: expect.stringMatching(/no longer exists/) });
  });
});

describe("exportFigmaLinkAction", () => {
  const out = { linkId: "l1", assetId: "a1", assetGroupId: "g1", versionNo: 2, name: "Hero.png", contentType: "image/png", byteSize: 9 };

  it("POSTs the format, and the scale only when one is given, and returns the new version", async () => {
    fetchMock.mockResolvedValue(out);
    const r = await exportFigmaLinkAction("l1", "png");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/figma-links/l1/export");
    expect(body()).toEqual({ format: "png" });
    expect(r.ok && r.export.versionNo).toBe(2);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(out);
    await exportFigmaLinkAction("l1", "pdf", 2);
    expect(body()).toEqual({ format: "pdf", scale: 2 });
  });

  it("says why when Figma is not connected or refuses", async () => {
    fetchMock.mockRejectedValue(refused(409, "figma_not_connected: no token"));
    expect(!(await exportFigmaLinkAction("l1", "svg")).ok).toBe(true);
    fetchMock.mockRejectedValue(refused(409, "figma_refused: x"));
    const r = await exportFigmaLinkAction("l1", "svg");
    expect(!r.ok && r.error).toMatch(/refused the company's token/);
  });

  it("never reaches the server with a format that is not png, svg or pdf", async () => {
    expect((await exportFigmaLinkAction("l1", "gif" as never)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("connectFigmaAction and disconnectFigmaAction", () => {
  it("PUTs the token and its type once, and the answer carries the masked status only", async () => {
    fetchMock.mockResolvedValue({ connected: true, tokenType: "pat" });
    const r = await connectFigmaAction("  figd_secret123  ", "pat");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/integrations/figma");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("PUT");
    expect(body()).toEqual({ token: "figd_secret123", tokenType: "pat" });
    expect(r).toEqual({ ok: true, connection: { connected: true, tokenType: "pat" } });
    expect(JSON.stringify(r)).not.toContain("figd_secret123");
  });

  it("never puts the token in a refusal either", async () => {
    fetchMock.mockRejectedValue(refused(403, "forbidden: figd_secret123"));
    const r = await connectFigmaAction("figd_secret123", "oauth");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("figd_secret123");
  });

  it("refuses an empty token, a token with spaces and an unknown type before any call", async () => {
    expect(await connectFigmaAction("  ", "pat")).toEqual({ ok: false, error: "Paste the Figma token first." });
    expect((await connectFigmaAction("a b", "pat")).ok).toBe(false);
    expect((await connectFigmaAction("abc", "basic" as never)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DELETEs the connection", async () => {
    fetchMock.mockResolvedValue({ disconnected: true });
    expect(await disconnectFigmaAction()).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/integrations/figma");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("DELETE");
  });

  it("a non-manager's 403 on disconnect is a sentence", async () => {
    fetchMock.mockRejectedValue(refused(403, "forbidden"));
    const r = await disconnectFigmaAction();
    expect(!r.ok && r.error).toMatch(/permission/);
  });
});
