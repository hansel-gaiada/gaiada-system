// TR-21 — the PURE + network-only half of the PDF export path: token generation (requirement 4:
// unguessable, encodes nothing) and `renderPdfViaSidecar`'s real HTTP behaviour against a genuine
// `node:http` server (real sockets, no mocked `fetch`) — same house pattern as report-export.test.ts
// (document-builder.test.ts, report-seal.test.ts): no database, no Nest. The mint/burn/Redis half
// needs a real Redis and lives in report-pdf-export.db.test.ts; the full createExport(format=pdf)
// orchestration (authz, files-table persistence, download) lives in
// reports.controller.export.pdf.db.test.ts, both against live Postgres + Redis + Cerbos.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PdfRenderFailedError, PdfRendererNotConfiguredError, generateJobToken, renderPdfViaSidecar } from "./report-pdf-export";

describe("generateJobToken — requirement 4: unguessable, encodes nothing about the document", () => {
  it("is base64url (no characters a raw path segment would need escaping) and long enough for real entropy", () => {
    const token = generateJobToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // randomBytes(32) base64url-encoded, no padding => 43 characters.
    expect(token.length).toBe(43);
  });

  it("is unique across many calls — no sequence, no shared prefix pattern", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateJobToken()));
    expect(tokens.size).toBe(500);
  });
});

describe("renderPdfViaSidecar — configuration guard (no network attempted when unconfigured)", () => {
  const full = { rendererUrl: "http://127.0.0.1:1", rendererToken: "t", platformUiInternalUrl: "http://127.0.0.1:1" };

  it("throws PdfRendererNotConfiguredError when rendererUrl is empty", async () => {
    await expect(renderPdfViaSidecar("tok", { ...full, rendererUrl: "" })).rejects.toBeInstanceOf(PdfRendererNotConfiguredError);
  });
  it("throws PdfRendererNotConfiguredError when rendererToken is empty", async () => {
    await expect(renderPdfViaSidecar("tok", { ...full, rendererToken: "" })).rejects.toBeInstanceOf(PdfRendererNotConfiguredError);
  });
  it("throws PdfRendererNotConfiguredError when platformUiInternalUrl is empty", async () => {
    await expect(renderPdfViaSidecar("tok", { ...full, platformUiInternalUrl: "" })).rejects.toBeInstanceOf(PdfRendererNotConfiguredError);
  });
});

describe("renderPdfViaSidecar — real HTTP round trip against a genuine node:http server (no mocked fetch)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("sends POST /render with the bearer token + a url built from platformUiInternalUrl + jobToken, and returns the real response bytes", async () => {
    let capturedAuth = "";
    let capturedBody = "";
    let capturedMethod = "";
    const url = await listen((req, res) => {
      capturedMethod = req.method ?? "";
      capturedAuth = req.headers.authorization ?? "";
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        capturedBody = raw;
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(Buffer.from("%PDF-fake-bytes"));
      });
    });

    const bytes = await renderPdfViaSidecar("abc123", {
      rendererUrl: url,
      rendererToken: "shared-renderer-token",
      platformUiInternalUrl: "http://platform-ui-internal.test",
    });

    expect(capturedMethod).toBe("POST");
    expect(capturedAuth).toBe("Bearer shared-renderer-token");
    expect(JSON.parse(capturedBody)).toEqual({ url: "http://platform-ui-internal.test/print/reports/abc123" });
    expect(bytes.toString()).toBe("%PDF-fake-bytes");
  });

  it("strips a trailing slash on both rendererUrl and platformUiInternalUrl before composing the request", async () => {
    let capturedUrl = "";
    let capturedTarget = "";
    const url = await listen((req, res) => {
      capturedUrl = req.url ?? "";
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        capturedTarget = (JSON.parse(raw) as { url: string }).url;
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(Buffer.from("ok"));
      });
    });

    await renderPdfViaSidecar("tok", { rendererUrl: `${url}/`, rendererToken: "t", platformUiInternalUrl: "http://ui.test/" });
    expect(capturedUrl).toBe("/render");
    expect(capturedTarget).toBe("http://ui.test/print/reports/tok");
  });

  it("a non-2xx sidecar response -> PdfRenderFailedError, never a silently-empty buffer", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "render failed" }));
    });
    await expect(renderPdfViaSidecar("tok", { rendererUrl: url, rendererToken: "t", platformUiInternalUrl: "http://ui.test" })).rejects.toBeInstanceOf(
      PdfRenderFailedError,
    );
  });

  it("respects timeoutMs — a sidecar that never responds is aborted rather than hanging forever", async () => {
    const url = await listen(() => {
      // Never calls res.end() — simulates a hung sidecar.
    });
    await expect(
      renderPdfViaSidecar("tok", { rendererUrl: url, rendererToken: "t", platformUiInternalUrl: "http://ui.test", timeoutMs: 50 }),
    ).rejects.toThrow();
  }, 5000);
});
