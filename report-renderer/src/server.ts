// report-renderer (TR-19) — Node + Playwright sidecar, tracker/reporting §6.3. The only image in
// the estate carrying Chromium; platform-ui's Next standalone image stays browser-free by design.
//
// POST /render {url} + `Authorization: Bearer RENDERER_TOKEN` -> chromium renders `url` and
// returns print-grade PDF bytes. Optional `footerText` (string) is the footer's left-hand text; escaped and capped. `url` MUST be same-origin with PLATFORM_UI_INTERNAL_URL (see
// auth.ts) — this service fetches whatever it is handed, so that check is the only thing standing
// between a leaked token and an SSRF proxy against the internal network. Internal network only;
// no tenant credentials ever reach it (TR-21 supplies a one-shot, doc-scoped, single-use jobToken
// baked into the URL path — this sidecar never sees a session cookie).
import "dotenv/config";
import express from "express";
import { chromium, type Browser } from "playwright";
import { isAllowedRenderUrl, isAuthorized } from "./auth.js";

const PORT = Number(process.env.RENDERER_PORT ?? 3007);
const RENDERER_TOKEN = process.env.RENDERER_TOKEN ?? "";
const PLATFORM_UI_INTERNAL_URL = process.env.PLATFORM_UI_INTERNAL_URL ?? "";

// Lift the in-repo working precedent's print technique (docs/blueprints/render-pdf.js): force
// exact colors, page numbers in the footer via headerTemplate/footerTemplate.
/** Default footer text when the caller sends none: neutral, no company name (PV-D13). */
export const DEFAULT_FOOTER_TEXT = "Report";
export const MAX_FOOTER_TEXT = 120;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Footer text from the request: a string, control characters dropped, capped, HTML-escaped. Anything else -> default. */
export function normalizeFooterText(v: unknown): string {
  if (typeof v !== "string") return DEFAULT_FOOTER_TEXT;
  // eslint-disable-next-line no-control-regex
  const cleaned = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_FOOTER_TEXT);
  return cleaned ? cleaned : DEFAULT_FOOTER_TEXT;
}

export function buildFooterTemplate(text: unknown): string {
  return `
  <div style="width:100%; font-size:8px; color:#444; padding:0 12mm;
       display:flex; justify-content:space-between;">
    <span>${escapeHtml(normalizeFooterText(text))}</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;
}

let browser: Browser | undefined;
async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) browser = await chromium.launch();
  return browser;
}

export const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "report-renderer" });
});

app.post("/render", async (req, res) => {
  if (!isAuthorized(req.header("authorization"), RENDERER_TOKEN)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { url, footerText } = req.body ?? {};
  if (typeof url !== "string" || !url) {
    return res.status(400).json({ error: "url (string) is required" });
  }
  if (!PLATFORM_UI_INTERNAL_URL || !isAllowedRenderUrl(url, PLATFORM_UI_INTERNAL_URL)) {
    // Deliberately vague — do not echo back what origin WOULD have been accepted.
    return res.status(403).json({ error: "url origin not allowed" });
  }

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    // A report PDF is ALWAYS light — never the viewer's dark theme (design decision, 2026-08-30).
    // This was previously true only by accident: this sidecar never sends a session cookie, so
    // platform-ui's root layout falls back to `theme: "auto"` and stamps no `data-theme`, which
    // hands the decision to `@media (prefers-color-scheme: dark)` in tokens/colors.css — and that
    // resolved light purely because Playwright's default colorScheme happens to be light. Nothing
    // in our own code said so. Declaring it here makes the guarantee ours: a Playwright default
    // change, a base-image swap, or any future authenticated render can no longer flip a
    // customer-facing PDF to dark. The token layer carries the matching belt (the `@media print`
    // block in tokens/colors.css re-declares the full light palette at a specificity that outranks
    // a pinned `html[data-theme="dark"]`); this line and that block are meant to be redundant.
    // `media: "print"` is what page.pdf() emulates anyway — stated explicitly so the two
    // emulation settings live in one place rather than one being implicit.
    await page.emulateMedia({ media: "print", colorScheme: "light" });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: buildFooterTemplate(footerText),
      margin: { top: "13mm", bottom: "16mm", left: "12mm", right: "12mm" },
    });
    res.setHeader("Content-Type", "application/pdf");
    res.send(pdf);
  } catch (err) {
    console.error("render failed", err);
    res.status(502).json({ error: "render failed" });
  } finally {
    await page?.close();
  }
});

// Only bind a port outside the test runner (`npx tsx src/server.ts` / the Dockerfile CMD) —
// importing `app` from server.test.ts must not open a socket. Vitest sets process.env.VITEST.
if (!process.env.VITEST) {
  app.listen(PORT, () => {
    console.log(`report-renderer listening on :${PORT}`);
  });
}
