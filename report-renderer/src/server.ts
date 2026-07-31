// report-renderer (TR-19) — Node + Playwright sidecar, tracker/reporting §6.3. The only image in
// the estate carrying Chromium; platform-ui's Next standalone image stays browser-free by design.
//
// POST /render {url} + `Authorization: Bearer RENDERER_TOKEN` -> chromium renders `url` and
// returns print-grade PDF bytes. `url` MUST be same-origin with PLATFORM_UI_INTERNAL_URL (see
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
const footerTemplate = `
  <div style="width:100%; font-size:8px; color:#444; padding:0 12mm;
       display:flex; justify-content:space-between;">
    <span>GAIADA — Report</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;

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

  const { url } = req.body ?? {};
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
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate,
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
