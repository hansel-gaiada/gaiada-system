// WSK-44 — the stub BFF as an HTTP server, for the Playwright run (e2e/webdesk-content.spec.ts).
//
//   node e2e/webdesk-stub/server.mjs            # listens on $WD_STUB_PORT (default 3991)
//
// `next start` runs with PLATFORM_URL pointing here and DEMO_MODE UNSET, so the app exercises its real
// `platformFetch` egress, its real session cookie and its real server components against this process.
// Two halves:
//   • the WebDesk content BFF (WSK-59), the approvals reads it needs, and `/__stub/*` scenario controls
//     — all in `wd.mjs`, transcribed from the spec;
//   • everything ELSE the ERP shell asks for (`/api/me`, org structure, the dept rail's queue, …) is
//     answered by the app's OWN demo fixtures (`src/lib/demoFixtures.ts`), bundled here with esbuild.
//     That is why the shell renders normally without this file re-implementing a single shell endpoint.
// Test fixture only. Nothing under `src/` imports this directory.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { addAsset, COMPANY, concurrentSave, decideApproval, handleKeyRequest, handlePublicMedia, handleWebdesk, listApprovals, mediaState, seed, setBuild } from "./wd.mjs";
import { reviewSnapshot } from "./editorial.mjs";
import { assistSnapshot, resetAssist } from "./assist.mjs";
import { conversationSnapshot, handlePortalConversation, handlePortalWebsite, isPortalConversationPath, isPortalWebsitePath, PORTAL_USERS, portalMe, portalOverview, portalUserIdFor, seedPortal, staffReply } from "./portal.mjs";

let heldGate = null;
let heldOpen = null;
const holdOn = () => { if (!heldGate) heldGate = new Promise((r) => { heldOpen = r; }); };
const holdOff = () => { if (heldOpen) heldOpen(); heldGate = null; heldOpen = null; };
const slow = async (S) => { if (heldGate) await heldGate; if (S.cfg.delayMs) await sleep(S.cfg.delayMs); };

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = Number(process.env.WD_STUB_PORT ?? 3991);

// ── bundle the app's demo fixtures (the shell's data) ─────────────────────────────────────────────
const out = fs.mkdtempSync(path.join(os.tmpdir(), "wd-stub-"));
await build({
  entryPoints: { demoFixtures: path.join(ROOT, "src/lib/demoFixtures.ts"), demoIdentity: path.join(ROOT, "src/lib/demoIdentity.ts") },
  outdir: out,
  bundle: true, platform: "node", format: "esm", logLevel: "error",
  outExtension: { ".js": ".mjs" },
  alias: { "@": path.join(ROOT, "src"), "server-only": path.join(ROOT, "e2e/webdesk-stub/empty.mjs") },
});
const { getDemoResponse } = await import(pathToFileURL(path.join(out, "demoFixtures.mjs")).href);
const { demoIdentityFor } = await import(pathToFileURL(path.join(out, "demoIdentity.mjs")).href);

let S = seedPortal(seed());
resetAssist(S); // the seed itself writes items through the same handlers; only writes AFTER it are the ledger's

function send(res, status, json) {
  const body = JSON.stringify(json);
  res.writeHead(status, { "content-type": status >= 400 && json && json.type ? "application/problem+json" : "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

// The body as RAW BYTES: the media upload is a binary file, and decoding it as UTF-8 would corrupt it. Everything else reads `raw` (the string).
const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks)));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://stub");
    const pathname = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    const rawBuf = await readBody(req);
    const raw = rawBuf.toString("utf8");
    const userId = String(req.headers["x-user-id"] ?? "demo-hansel");
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }

    // ── WebDesk's PUBLIC media routes: the fake upload endpoint (the browser POSTs the file here, never to the ERP) ──
    if (pathname.startsWith("/v1/t/")) {
      const m = handlePublicMedia(S, { method, pathname, query: url.searchParams, headers: req.headers, body: rawBuf });
      if (m) {
        const headers = { ...(m.headers ?? {}) };
        if (m.bytes) { headers["content-length"] = m.bytes.length; res.writeHead(m.status, headers); return res.end(m.bytes); }
        if (m.json !== undefined) { const b = JSON.stringify(m.json); res.writeHead(m.status, { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(b) }); return res.end(b); }
        res.writeHead(m.status, headers);
        return res.end();
      }
    }

    // ── scenario controls ───────────────────────────────────────────────────────────────────────
    if (pathname.startsWith("/__stub/")) {
      const cmd = pathname.slice("/__stub/".length);
      // `hold` latch: while held, every content-BFF read parks until `release` (a deterministic "slow API": the test
      // asserts the loading state, THEN releases). Replaces racing a fixed delay against the router.
      if (cmd === "hold") { holdOn(); return send(res, 200, { ok: true }); }
      if (cmd === "release") { holdOff(); return send(res, 200, { ok: true }); }
      if (cmd === "reset") { holdOff(); S = seedPortal(seed()); resetAssist(S); return send(res, 200, { ok: true }); }
      if (cmd === "config") { Object.assign(S.cfg, body ?? {}); return send(res, 200, S.cfg); }
      // Put an asset straight into the library (no upload): { title?, alt?, tags?, mime?, originalFilename?, width?, height?, createdBy?, createdAt? }
      if (cmd === "seed-media") return send(res, 200, { assetId: addAsset(S, body ?? {}) });
      if (cmd === "state") {
        return send(res, 200, {
          ...mediaState(S),
          items: [...S.items.values()].map((i) => ({ itemId: i.itemId, slug: i.slug, locale: i.locale, headVersion: i.versions.at(-1).n, publishedVersion: i.publishedVersion, publishState: i.publishState, deletedAt: i.deletedAt, versions: i.versions.map((v) => ({ n: v.n, createdBy: v.createdBy, note: v.note, props: v.blocks[0]?.props, seo: v.seo })) })),
          approvals: [...S.approvals.values()], build: S.build, stagingStale: S.stagingStale, review: reviewSnapshot(S), assist: assistSnapshot(S),
        });
      }
      // PV4-08: a staff member answers in a client's conversation thread, and the spec reads back what the server holds.
      if (cmd === "staff-reply") return send(res, 200, staffReply(S, body ?? {}));
      if (cmd === "conversation-state") return send(res, 200, conversationSnapshot(S));
      if (cmd === "decide") { const r = decideApproval(S, body.id, body.outcome, body.by); return send(res, r.status, r.json); }
      if (cmd === "corrupt-args") { const a = S.approvals.get(body.id); if (a) a.toolArgs = { unexpected: true }; return send(res, 200, { ok: !!a }); }
      // File a key.mint request AS another user (so the logged-in user can approve it: maker != checker).
      if (cmd === "request-key") { const r = handleKeyRequest(S, { method: "POST", siteId: body.siteId ?? "site-gaiada-com", body: { tenantSlug: "gaiada", envId: body.envId, scope: body.scope ?? "read" }, userId: body.by ?? "dept-manager", company: COMPANY }); return send(res, r.status, r.json); }
      if (cmd === "build") { setBuild(S, body.state, body.stagingStale); return send(res, 200, { build: S.build, stagingStale: S.stagingStale }); }
      if (cmd === "concurrent-save") { return send(res, 200, concurrentSave(S, body.itemId, body.fields ?? {}, body.by)); }
      return send(res, 404, { error: `unknown stub command ${cmd}` });
    }

    // ── login: the dev path's email -> user id lookup ───────────────────────────────────────────
    // WSK-49d: the portal's client editors (e2e/portal-website.spec.ts) have their own ids; every other address keeps the app's demo mapping.
    if (pathname === "/dev/user-by-email") return send(res, 200, { id: portalUserIdFor(url.searchParams.get("email") ?? "") ?? demoIdentityFor(url.searchParams.get("email") ?? "") });

    // ── the client portal: who the viewer is, and the client website BFF (§16j) ─────────────────
    if (PORTAL_USERS[userId] && pathname === "/api/me") return send(res, 200, portalMe(userId));
    if (PORTAL_USERS[userId] && /^\/api\/[^/]+\/portal\/overview$/.test(pathname)) return send(res, 200, portalOverview(S));
    // PV4-08: the client Conversation BFF (§29a).
    if (isPortalConversationPath(pathname)) {
      await slow(S);
      const r = handlePortalConversation(S, { method, pathname, body, userId });
      return send(res, r.status, r.json);
    }
    if (isPortalWebsitePath(pathname)) {
      await slow(S);
      const pm = pathname.match(/^\/api\/([^/]+)\//);
      const r = handlePortalWebsite(S, { method, pathname, query: url.searchParams, body, userId, company: decodeURIComponent(pm[1]) });
      return send(res, r.status, r.json);
    }

    // ── WebDesk content BFF ─────────────────────────────────────────────────────────────────────
    const wd = pathname.match(/^\/api\/([^/]+)\/modules\/webdev\/content(\/.*)?$/);
    if (wd) {
      await slow(S);
      const r = handleWebdesk(S, { method, pathname, query: url.searchParams, body, userId, company: decodeURIComponent(wd[1]) });
      return send(res, r.status, r.json);
    }

    // ── control plane: "Request an API key" files a key.mint approval ───────────────────────────
    const ck = pathname.match(/^\/api\/([^/]+)\/modules\/webdev\/control\/sites\/([^/]+)\/keys$/);
    if (ck) {
      await slow(S);
      const r = handleKeyRequest(S, { method, siteId: decodeURIComponent(ck[2]), body, userId, company: decodeURIComponent(ck[1]) });
      return send(res, r.status, r.json);
    }

    // ── approvals the content workspace files / reads (origin `webdesk`) ─────────────────────────
    const ap = pathname.match(/^\/api\/([^/]+)\/automation-approvals(?:\/([^/]+))?$/);
    if (ap && method === "GET") {
      const company = decodeURIComponent(ap[1]);
      if (!ap[2]) {
        // `automation_approval:read` (company_admin/manager) — the editor no longer calls the list (WSK-44b).
        if (url.searchParams.get("origin") === "webdesk") return send(res, S.cfg.approvalReadForbidden ? 403 : 200, S.cfg.approvalReadForbidden ? { error: "forbidden" } : company === COMPANY ? listApprovals(S, url.searchParams) : []);
      } else if (S.approvals.has(ap[2])) {
        // A requester without `automation_approval:read` (webdev_staff) is refused here: the REAL detail route has no
        // requester carve-out, which is why the editor's poll falls back to `…/publish-requests`.
        if (S.cfg.approvalReadForbidden) return send(res, 403, { error: "forbidden" });
        // Approvals live in one company; every other tenant gets the 404 a cross-tenant id gets (RLS).
        return company === COMPANY ? send(res, 200, S.approvals.get(ap[2])) : send(res, 404, { error: "not found" });
      }
    }
    // The unified inbox's decide façade, for an approval this stub owns.
    const dec = pathname.match(/^\/api\/([^/]+)\/approvals\/([^/]+)\/decide$/);
    if (dec && method === "POST" && S.approvals.has(dec[2])) {
      const r = decideApproval(S, dec[2], body?.decision === "rejected" ? "reject" : "approve", userId);
      return send(res, r.status, r.json);
    }

    // ── everything else: the app's own demo fixtures ────────────────────────────────────────────
    const demo = getDemoResponse(method, `${pathname}${url.search}`, userId, raw || undefined);
    return send(res, demo.status, demo.json);
  } catch (e) {
    console.error("[wd-stub]", e);
    return send(res, 500, { error: String(e?.message ?? e) });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`[wd-stub] listening on http://127.0.0.1:${PORT}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); fs.rmSync(out, { recursive: true, force: true }); process.exit(0); });
