// WSK-49d — the stubbed CLIENT website BFF (FRONTEND-BFF-CONTRACT §16j, WSK-49c) for the portal Website area's Playwright run
// (e2e/portal-website.spec.ts). TEST FIXTURE ONLY: nothing under `src/` imports it.
//
//   /api/:t/portal/clients/:clientId/website/…
//
// IT MATCHES THE CONTRACT, NOT THE UI, and it delegates the way the real BFF does: every immediate write, the reads and the media calls are
// the STAFF stub's (`wd.mjs`, `media.mjs`) handed a client's identity; what is specific to a client is here:
//   * the order on every route: grant (a client editor of THIS client) -> the site wall (the site must be linked to the client) -> the
//     strict body -> the D59 / D62 pre-check -> only then the staff call;
//   * `clientEditable` on collections and on the item read, computed by a JS port of `isClientEditable` (webdesk/delivery/vocabulary/
//     client-editable.ts: field.ui.clientEditable ?? parent group ?? collection.ui.clientEditable ?? false; seo never) over a composition
//     whose flags this file sets (`CLIENT_FLAGS`): the shared compositions carry no `ui.clientEditable`;
//   * D59 on create / update / restore (`422 field-not-client-editable`, pointers), D62 on publish (`422 publish-not-client-editable`),
//     `409 item-deleted`, a stale base is `409 version-conflict` BEFORE the diff, no schedule (`403 client-command-not-allowed`);
//   * D58: self-publish ONE item (files + approves as the same person), a batch needs a DIFFERENT client editor (a self-approved batch is 403);
//   * the publish-request list for THIS client, `requestedByMe` / `canApprove`, withdraw by the requester only.
// A staff member gets `403 not a portal client`; a client contact without the grant gets a 403 from the first line of every handler.

import { COMPANY, SITE, TENANT, decideApproval, handleWebdesk } from "./wd.mjs";
import { handleMediaBff } from "./media.mjs";

export const CLIENT_ID = "0c1e57a1-5a0e-4c11-8d10-000000000c01";
export const CLIENT_NAME = "Northwind Traders";

/** The portal identities. `editor` = holds `client_website_editor` for CLIENT_ID. */
export const PORTAL_USERS = {
  "wd-client-a": { name: "Dana Editor", email: "editor1@northwind.example", editor: true },
  "wd-client-b": { name: "Ewan Editor", email: "editor2@northwind.example", editor: true },
  "wd-client-v": { name: "Vera Viewer", email: "viewer@northwind.example", editor: false },
};
export const portalUserIdFor = (email) => Object.entries(PORTAL_USERS).find(([, u]) => u.email === String(email).toLowerCase())?.[0] ?? null;

/** `/api/me` for a portal identity: a client contact of co-agency, plus (editors) the client-scoped website grant. */
export function portalMe(userId) {
  const u = PORTAL_USERS[userId];
  if (!u) return null;
  return {
    userId, name: u.name, email: u.email, title: "Marketing, Northwind", assurance: "high",
    companies: [{ id: COMPANY, name: "Gaia Digital Agency", type: "agency" }],
    roles: [
      { role: "client", scopeType: "company", scopeId: COMPANY },
      ...(u.editor ? [{ role: "client_website_editor", scopeType: "client", scopeId: CLIENT_ID }] : []),
    ],
    clientOf: [{ companyId: COMPANY, companyName: "Gaia Digital Agency" }],
  };
}

/** `GET /api/:t/portal/overview` as far as the portal layout reads it (the client list, for the Website tab and the page guard). */
export const portalOverview = (S) => ({
  clients: [{ id: CLIENT_ID, name: CLIENT_NAME, status: "active" }], client: { id: CLIENT_ID, name: CLIENT_NAME, status: "active" }, viewOnly: false,
  progress: { projects: 0, activeProjects: 0, completedProjects: 0, percent: 0 }, deliverables: { total: 0, delivered: 0, overdue: 0 },
  nextMilestone: null, needsYou: [], finance: { byCurrency: [], primary: null },
  // PV4-06 (§29d): threads with unread messages from staff.
  conversationUnread: S?.portal?.conv ? unreadThreads(S) : 0,
});

// ── Compositions with client flags (the shared fixtures carry none) ────────────────────────────────────
//   service        h1, body, plan.why are the client's; the rest is Gaiada's. Required fields only Gaiada can fill => a client create is IMPOSSIBLE.
//   banner         the whole collection is the client's (`ui.clientEditable: true`): create works, the media picker has a field to fill.
//   everything else (navigation, token-registry, company): nothing is editable.
const CLIENT_FLAGS = {
  service: { fields: { h1: true, body: true, "plan.why": true } },
  banner: { collection: true },
};

function composedFor(S, key) {
  const c = JSON.parse(JSON.stringify(S.compositions[key]));
  const flags = CLIENT_FLAGS[key];
  if (!flags) return c;
  if (flags.collection) c.ui = { ...(c.ui ?? {}), clientEditable: true };
  const mark = (defs, prefix) => {
    for (const f of defs ?? []) {
      const k = prefix ? `${prefix}.${f.name}` : f.name;
      if (flags.fields && k in flags.fields) f.ui = { ...(f.ui ?? {}), clientEditable: flags.fields[k] };
      if (f.primitive === "group") mark(f.fields, k);
    }
  };
  mark(c.fields, "");
  return c;
}

const isRec = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const collectionDefault = (c) => isRec(c.ui) && c.ui.clientEditable === true;
const effective = (f, inherited) => (isRec(f.ui) && typeof f.ui.clientEditable === "boolean" ? f.ui.clientEditable : inherited);

/** The BFF's `clientEditable` map (a port of `clientEditableMap`). */
function clientEditableMap(key, c) {
  const fields = {};
  const walk = (defs, inherited, prefix) => {
    for (const f of defs ?? []) {
      const k = prefix ? `${prefix}.${f.name}` : f.name;
      const eff = effective(f, inherited);
      fields[k] = eff;
      if (f.primitive === "group") walk(f.fields, eff, k);
    }
  };
  walk(c.fields, collectionDefault(c), "");
  const anyField = Object.values(fields).some(Boolean);
  const allowedAtAll = anyField || (collectionDefault(c) && (c.blocks === undefined || (Array.isArray(c.blocks) && c.blocks.length > 0)));
  const blockedBy = (c.fields ?? []).filter((f) => f.required === true && fields[f.name] === false).map((f) => f.name);
  const create = !allowedAtAll
    ? { allowed: false, reason: "nothing-editable", blockedBy: [] }
    : blockedBy.length ? { allowed: false, reason: "required-fields-not-editable", blockedBy } : { allowed: true, reason: null, blockedBy: [] };
  return { fields, blocks: collectionDefault(c), seo: false, create };
}

/** `isClientEditable` for a pointer into stored content `{blocks, seo}`. */
function pointerEditable(c, pointer) {
  const segs = pointer.slice(1).split("/").map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segs[0] === "seo") return false;
  if (segs[0] !== "blocks" || !/^\d+$/.test(segs[1] ?? "")) return false;
  const declares = Array.isArray(c.fields);
  if (declares && segs[1] === "0") {
    if (segs[2] !== "props" || segs.length < 4) return false;
    let defs = c.fields; let inherited = collectionDefault(c); let i = 3;
    for (;;) {
      const f = (defs ?? []).find((d) => d.name === segs[i]);
      if (!f) return false;
      const eff = effective(f, inherited);
      i++;
      if (f.primitive !== "group") return eff;
      if (f.multiple) { if (i >= segs.length) return eff; if (!/^\d+$/.test(segs[i])) return false; i++; }
      if (i >= segs.length) return eff;
      defs = f.fields; inherited = eff;
    }
  }
  return collectionDefault(c);
}

const esc = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function leaves(v, ptr, out) {
  if (Array.isArray(v)) { if (v.length === 0) out.add(ptr); v.forEach((x, i) => leaves(x, `${ptr}/${i}`, out)); return; }
  if (isRec(v)) { const ks = Object.keys(v); if (ks.length === 0) out.add(ptr); ks.forEach((k) => leaves(v[k], `${ptr}/${esc(k)}`, out)); return; }
  out.add(ptr);
}
function diff(a, b, ptr, out) {
  if (deepEq(a, b)) return;
  if (isRec(a) && isRec(b)) { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${ptr}/${esc(k)}`, out); return; }
  if (Array.isArray(a) && Array.isArray(b)) { for (let i = 0; i < Math.max(a.length, b.length); i++) diff(a[i], b[i], `${ptr}/${i}`, out); return; }
  const cont = (v) => Array.isArray(v) || isRec(v);
  if ((a !== undefined && !cont(a)) || (b !== undefined && !cont(b))) out.add(ptr);
  for (const side of [a, b]) if (cont(side)) leaves(side, ptr, out);
}
const changed = (before, after) => { const out = new Set(); diff(before.blocks, after.blocks, "/blocks", out); diff(before.seo, after.seo, "/seo", out); return [...out].sort(); };

// ── RFC 9457 problems, as WebDesk and the BFF send them ────────────────────────────────────────────────
const PROBLEM = "https://webdesk.gaiada.online/errors/";
const R = (status, json) => ({ status, json });
const problem = (status, slug, title, extra = {}) => R(status, { type: `${PROBLEM}${slug}`, title, status, instance: "/stub", requestId: "stub-req", ...extra });
const forbidden = () => R(403, { error: "forbidden" });
const fieldNotEditable = (paths, detail) => problem(422, "field-not-client-editable", "Field not client editable", { detail: detail ?? "A client editor may only change what the composition marks client-editable. Nothing was written.", issues: paths.map((path) => ({ path, message: "not client-editable" })) });
const itemNotFound = () => problem(404, "item-not-found", "Item not found");
const siteNotFound = () => problem(404, "site-not-found", "Site not found");

const head = (it) => it.versions[it.versions.length - 1];

/** WSK-359: `authors: {<id>: label}` for every author id in a read, as the BFF resolves them: a contact of THIS client -> their name;
 *  Gaiada staff -> "Gaiada" (never a personal name); anyone else -> "Someone else". */
const STAFF_IDS = new Set(["demo-hansel", "dept-manager", "gede-ic"]);
export function authorLabel(id) {
  if (PORTAL_USERS[id]) return PORTAL_USERS[id].name;
  return STAFF_IDS.has(id) ? "Gaiada" : "Someone else";
}
function withAuthors(r) {
  if (r.status !== 200 || !isRec(r.json)) return r;
  const ids = new Set();
  const add = (v) => { if (typeof v === "string" && v !== "") ids.add(v); };
  if (isRec(r.json.version)) add(r.json.version.createdBy);
  add(r.json.createdBy);
  if (Array.isArray(r.json.versions)) for (const v of r.json.versions) add(v?.createdBy);
  if (Array.isArray(r.json.items)) for (const i of r.json.items) add(i?.headCreatedBy);
  if (ids.size === 0) return r;
  return R(200, { ...r.json, authors: Object.fromEntries([...ids].map((id) => [id, authorLabel(id)])) });
}

const staffBase = `/api/${COMPANY}/modules/webdev/content/sites/${TENANT}/${SITE}`;
const staff = (S, userId, method, rest, body, query = new URLSearchParams()) =>
  handleWebdesk(S, { method, pathname: `${staffBase}${rest}`, query, body, userId, company: COMPANY });

function splitStored(c, v) {
  const first = v.blocks[0];
  if (Array.isArray(c.fields) && first && first.type === "fields") return { fields: first.props ?? {}, blocks: v.blocks.slice(1) };
  return { fields: {}, blocks: v.blocks };
}
const assemble = (c, fields, blocks) => (Array.isArray(c.fields) ? [{ type: "fields", props: fields }, ...blocks] : blocks);

/** D62 for ONE item: what going live would change on the LIVE page must all be client-editable (a never-published item is judged against empty). */
function publishViolations(S, itemId, version, index) {
  const it = S.items.get(itemId);
  if (!it) return null;
  const c = composedFor(S, it.collectionKey);
  const v = it.versions.find((x) => x.n === version);
  if (!v) return null;
  const live = it.publishedVersion !== null ? it.versions.find((x) => x.n === it.publishedVersion) : null;
  const base = live ?? { blocks: Array.isArray(c.fields) ? [{ type: "fields", props: {} }] : [], seo: {} };
  return changed(base, v).filter((p) => !pointerEditable(c, p)).map((p) => `/items/${index}${p}`);
}

export function seedPortal(S) {
  S.cfg.previewMissing = false;
  S.portal = { conv: seedConversation() };
  // A second client banner, so a batch has two items to choose.
  staff(S, "demo-hansel", "POST", "/collections/banner/items", { locale: "en", slug: "banner.autumn", fields: { title: "Autumn banner" } });
  return S;
}

const BASE_RE = /^\/api\/([^/]+)\/portal\/clients\/([^/]+)\/website(\/.*)?$/;
export const isPortalWebsitePath = (pathname) => BASE_RE.test(pathname);

export function handlePortalWebsite(S, { method, pathname, query, body, userId, company }) {
  const m = pathname.match(BASE_RE);
  const clientId = decodeURIComponent(m[2]);
  const rest = m[3] ?? "";
  const user = PORTAL_USERS[userId];

  // (1) the grant: first, so a denial is a 403 whatever the body. A staff member holds no client grant and is refused here too.
  if (!user) return R(403, { error: "not a portal client" });
  if (!user.editor || clientId !== CLIENT_ID || company !== COMPANY) return forbidden();
  if (S.cfg.unavailable) return R(503, { error: "editorial_unavailable" });
  if (S.cfg.unavailableOnce > 0) { S.cfg.unavailableOnce -= 1; return R(503, { error: "editorial_unavailable" }); }

  if (rest === "" && method === "GET") {
    return R(200, { clientId: CLIENT_ID, sites: [{ tenantSlug: TENANT, siteId: SITE, name: "gaiada.com", kind: "static", defaultLocale: "en", locales: ["en", "id"], linkedAt: "2026-10-11T09:00:00.000Z" }] });
  }

  // the publish-request list and approve are client-level (not under a site)
  if (rest === "/publish-requests" && method === "GET") return listRequests(S, userId, query);
  let mm;
  if ((mm = rest.match(/^\/publish-requests\/([^/]+)\/approve$/)) && method === "POST") return approve(S, userId, mm[1]);

  // (2) the site wall: the site must be linked to THIS client (anything else is the uniform 404, no existence oracle)
  const sm = rest.match(/^\/sites\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!sm) return R(404, { error: `Cannot ${method} ${pathname}` });
  if (decodeURIComponent(sm[1]) !== TENANT || decodeURIComponent(sm[2]) !== SITE) return siteNotFound();
  const sub = sm[3] ?? "";

  if (sub === "/collections" && method === "GET") {
    const r = staff(S, userId, "GET", "/collections", undefined, query);
    if (r.status !== 200) return r;
    return R(200, { ...r.json, collections: r.json.collections.map((c) => { const comp = composedFor(S, c.key); return { ...c, composition: comp, clientEditable: clientEditableMap(c.key, comp) }; }) });
  }

  if ((mm = sub.match(/^\/collections\/([^/]+)\/items$/))) {
    const key = mm[1];
    if (method === "GET") {
      if (query.get("includeDeleted") !== null || query.get("state") === "deleted") return problem(400, "invalid-request", "Invalid request", { detail: "a client editor cannot list deleted items" });
      const q = new URLSearchParams(query);
      const slug = q.get("slug"); q.delete("slug");
      const r = staff(S, userId, "GET", `/collections/${key}/items`, undefined, q);
      if (r.status === 200 && slug) r.json = { ...r.json, items: r.json.items.filter((i) => i.slug === slug) };
      return withAuthors(r);
    }
    if (method === "POST") return createItem(S, userId, key, body);
  }

  if ((mm = sub.match(/^\/items\/([^/]+)$/))) {
    const it = S.items.get(mm[1]);
    if (method === "GET") {
      if (!it || it.deletedAt) return itemNotFound();
      const r = staff(S, userId, "GET", `/items/${mm[1]}`, undefined, query);
      if (r.status !== 200) return r;
      const comp = composedFor(S, it.collectionKey);
      return withAuthors(R(200, { ...r.json, composition: comp, clientEditable: clientEditableMap(it.collectionKey, comp) }));
    }
    if (method === "PUT") return updateItem(S, userId, it, body);
  }
  if ((mm = sub.match(/^\/items\/([^/]+)\/versions(?:\/(\d+))?$/)) && method === "GET") {
    const it = S.items.get(mm[1]);
    if (!it || it.deletedAt) return itemNotFound();
    return withAuthors(staff(S, userId, "GET", `/items/${mm[1]}/versions${mm[2] ? `/${mm[2]}` : ""}`, undefined, query));
  }
  if ((mm = sub.match(/^\/items\/([^/]+)\/restore$/)) && method === "POST") return restoreItem(S, userId, S.items.get(mm[1]), body);
  if ((mm = sub.match(/^\/items\/([^/]+)\/preview$/)) && method === "POST") return previewItem(S, S.items.get(mm[1]), body);
  if ((mm = sub.match(/^\/items\/([^/]+)\/publish$/)) && method === "POST") return selfPublish(S, userId, S.items.get(mm[1]), body);
  if (sub === "/publish-requests" && method === "POST") return requestPublish(S, userId, body);
  if ((mm = sub.match(/^\/publish-requests\/([^/]+)\/withdraw$/)) && method === "POST") return withdraw(S, userId, mm[1]);

  if (sub === "/media" || sub.startsWith("/media/")) {
    if (method === "DELETE" || /\/usage$/.test(sub)) return R(404, { error: `Cannot ${method} ${pathname}` }); // there is NO route to delete media or read its usage
    if (query.get("includeDeleted") !== null) return problem(400, "invalid-request", "Invalid request", { detail: "a client editor cannot list deleted media" });
    return handleMediaBff(S, { method, rest: sub, query, body, userId, role: "publisher", client: true }) ?? R(404, { error: `Cannot ${method} ${pathname}` });
  }
  return R(404, { error: `Cannot ${method} ${pathname}` });
}

// ── writes ─────────────────────────────────────────────────────────────────────────────────────────────

function strict(body, allowed) {
  if (body === undefined) return {};
  if (!isRec(body)) return null;
  return Object.keys(body).every((k) => allowed.includes(k)) ? body : null;
}
const badBody = (m) => problem(400, "invalid-request", "Invalid request", { detail: m });

function createItem(S, userId, key, raw) {
  const b = strict(raw, ["collectionKey", "locale", "slug", "twinOf", "fields", "blocks", "seo", "note"]);
  if (!b) return badBody("unknown key in the body");
  if (isRec(b.seo) && Object.keys(b.seo).length > 0) return fieldNotEditable(["/seo"]);
  if (!S.compositions[key]) return problem(404, "collection-not-found", "Collection not found");
  const c = composedFor(S, key);
  const verdict = clientEditableMap(key, c).create;
  if (!verdict.allowed) {
    return verdict.reason === "required-fields-not-editable"
      ? fieldNotEditable(verdict.blockedBy.map((n) => `/blocks/0/props/${esc(n)}`), `A client editor cannot create an item in collection "${key}": the required field(s) ${verdict.blockedBy.join(", ")} are not client-editable.`)
      : fieldNotEditable(["/collectionKey"]);
  }
  const content = { blocks: assemble(c, b.fields ?? {}, b.blocks ?? []), seo: {} };
  // every non-editable part must be absent: compared with a blank item
  const blank = { blocks: Array.isArray(c.fields) ? [{ type: "fields", props: {} }] : [], seo: {} };
  const bad = changed(blank, content).filter((p) => !pointerEditable(c, p));
  if (bad.length) return fieldNotEditable(bad);
  const { seo: _seo, ...forward } = b; void _seo;
  return staff(S, userId, "POST", `/collections/${key}/items`, forward);
}

function updateItem(S, userId, it, raw) {
  const b = strict(raw, ["baseVersion", "fields", "blocks", "seo", "note"]);
  if (!b) return badBody("unknown key in the body");
  if (isRec(b.seo) && Object.keys(b.seo).length > 0) return fieldNotEditable(["/seo"]);
  if (!Number.isInteger(b.baseVersion) || b.baseVersion < 0) return badBody("baseVersion must be a non-negative integer");
  if (!it) return itemNotFound();
  if (it.deletedAt) return problem(409, "item-deleted", "Item deleted");
  const h = head(it);
  // a stale base is decided FIRST, before the D59 diff: a head that moved is never answered as a 422 about a field the client did not touch
  if (b.baseVersion !== h.n) return problem(409, "version-conflict", "Version conflict", { currentHeadVersion: h.n, currentContentHash: h.contentHash, updatedAt: h.createdAt });
  const c = composedFor(S, it.collectionKey);
  const stored = splitStored(c, h);
  const fields = b.fields ?? stored.fields;
  const blocks = b.blocks ?? stored.blocks;
  const after = { blocks: assemble(c, fields, blocks), seo: h.seo };
  const bad = changed({ blocks: h.blocks, seo: h.seo }, after).filter((p) => !pointerEditable(c, p));
  if (bad.length) return fieldNotEditable(bad);
  return staff(S, userId, "PUT", `/items/${it.itemId}`, { baseVersion: b.baseVersion, fields, blocks, seo: h.seo, ...(b.note !== undefined ? { note: b.note } : {}) });
}

function restoreItem(S, userId, it, raw) {
  const b = strict(raw, ["version", "baseVersion", "note"]);
  if (!b || !Number.isInteger(b.version) || !Number.isInteger(b.baseVersion)) return badBody("version and baseVersion are required");
  if (!it) return itemNotFound();
  if (it.deletedAt) return problem(409, "item-deleted", "Item deleted");
  const h = head(it);
  if (b.baseVersion !== h.n) return problem(409, "version-conflict", "Version conflict", { currentHeadVersion: h.n, currentContentHash: h.contentHash, updatedAt: h.createdAt });
  const src = it.versions.find((x) => x.n === b.version);
  if (!src) return problem(404, "version-not-found", "Version not found");
  const c = composedFor(S, it.collectionKey);
  const bad = changed({ blocks: h.blocks, seo: h.seo }, { blocks: src.blocks, seo: src.seo }).filter((p) => !pointerEditable(c, p));
  if (bad.length) return fieldNotEditable(bad);
  return staff(S, userId, "POST", `/items/${it.itemId}/restore`, b);
}

function previewItem(S, it, raw) {
  const b = strict(raw, ["version"]);
  if (!b) return badBody("unknown key in the body");
  if (!it || it.deletedAt) return itemNotFound();
  if (S.cfg.previewMissing) return problem(409, "preview_page_missing", "Preview page missing", { detail: "The site has no /preview/ page." });
  return R(200, { previewUrl: "https://24-pyevq.gaiada.com/preview/#t=stub-preview-token", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), version: b.version ?? head(it).n });
}

// ── publishing ──────────────────────────────────────────────────────────────────────────────────────────

function fileRequest(S, userId, items) {
  const r = staff(S, userId, "POST", "/publish-requests", { items });
  if (r.status !== 202) return r;
  const row = S.approvals.get(r.json.approvalId);
  row.toolArgs.clientId = CLIENT_ID; // the portal BFF's own marker: the request is THIS client's
  return R(202, { approvalId: r.json.approvalId, command: "content.publish", itemCount: items.length });
}

function requestPublish(S, userId, raw) {
  if (isRec(raw) && ("publishAt" in raw || "unpublishAt" in raw)) return problem(403, "client-command-not-allowed", "Client command not allowed", { detail: "a client never schedules" });
  const b = strict(raw, ["items", "note"]);
  if (!b || !Array.isArray(b.items) || b.items.length === 0) return badBody("items must be a non-empty list");
  const all = [];
  for (const [i, x] of b.items.entries()) {
    if (!isRec(x) || typeof x.itemId !== "string" || !Number.isInteger(x.version) || x.version < 1) return badBody("each item needs an itemId and a version");
    const it = S.items.get(x.itemId);
    if (!it || it.deletedAt) return itemNotFound();
    const bad = publishViolations(S, x.itemId, x.version, i);
    if (bad === null) return problem(404, "version-not-found", "Version not found");
    all.push(...bad);
  }
  if (all.length) return problem(422, "publish-not-client-editable", "Publish not client editable", { detail: "The draft includes changes only Gaiada can publish.", issues: all.map((path) => ({ path, message: "not client-editable" })) });
  return fileRequest(S, userId, b.items.map((x) => ({ itemId: x.itemId, version: x.version })));
}

/** The staging rebuild as the BFF shows a client (WSK-D65): `{state, failureReason}` only. `cfg.portalBuild` sets it (default: rebuilding);
 *  `null` omits it, as an older BFF would. */
const clientBuild = (S) => (S.cfg.portalBuild === null ? {} : { build: S.cfg.portalBuild ?? { state: "rebuilding", failureReason: null } });

function approveBody(S, id, selfPublish) {
  const a = S.approvals.get(id);
  return R(200, { approvalId: id, status: a.status, executionStatus: a.executionStatus === "executed" ? "executed" : "failed", ...(a.executionStatus === "executed" ? { selfPublish, reconciled: S.cfg.reconciled !== false, items: a.toolArgs.items.map((i) => ({ itemId: i.itemId, version: i.version })), ...clientBuild(S) } : { error: a.executionError ?? "failed" }) });
}

function selfPublish(S, userId, it, raw) {
  const b = strict(raw, ["version"]);
  if (!b) return badBody("unknown key in the body");
  if (!it || it.deletedAt) return itemNotFound();
  const version = b.version ?? head(it).n;
  const bad = publishViolations(S, it.itemId, version, 0);
  if (bad === null) return problem(404, "version-not-found", "Version not found");
  if (bad.length) return problem(422, "publish-not-client-editable", "Publish not client editable", { detail: "The draft includes changes only Gaiada can publish.", issues: bad.map((path) => ({ path, message: "not client-editable" })) });
  const filed = fileRequest(S, userId, [{ itemId: it.itemId, version }]);
  if (filed.status !== 202) return filed;
  if (S.cfg.publishFails) { const a = S.approvals.get(filed.json.approvalId); a.status = "approved"; a.executionStatus = "failed"; a.executionError = "version-conflict"; return approveBody(S, filed.json.approvalId, true); }
  const d = decideApproval(S, filed.json.approvalId, "approve", userId);
  if (d.status !== 200) return d;
  return approveBody(S, filed.json.approvalId, true);
}

function approve(S, userId, id) {
  const a = S.approvals.get(id);
  if (!a || a.origin !== "webdesk" || a.workflowId !== "content.publish" || a.toolArgs.clientId !== CLIENT_ID) return R(404, { error: "approval_not_found", reason: "approval_not_found" });
  if (a.status !== "pending") return R(409, { error: "approval_not_pending: the request is no longer pending", reason: "approval_not_pending" });
  // D58: the requester may approve a request for ONE item; a batch needs a DIFFERENT client editor (Cerbos: a self-approved batch is denied)
  if (a.requestedBy === userId && a.toolArgs.items.length > 1) return forbidden();
  // D62 again, now: the live page may have moved since filing (the request stays pending)
  const bad = a.toolArgs.items.flatMap((x, i) => publishViolations(S, x.itemId, x.version, i) ?? []);
  if (bad.length) return problem(422, "publish-not-client-editable", "Publish not client editable", { detail: "The draft includes changes only Gaiada can publish.", issues: bad.map((path) => ({ path, message: "not client-editable" })) });
  if (S.cfg.publishFails) { a.status = "approved"; a.executionStatus = "failed"; a.executionError = "version-conflict"; return approveBody(S, id, false); }
  const d = decideApproval(S, id, "approve", userId);
  if (d.status !== 200) return d;
  return approveBody(S, id, a.requestedBy === userId);
}

function listRequests(S, userId, query) {
  const want = query.get("status") ?? "pending";
  if (!["pending", "approved", "rejected", "cancelled", "all"].includes(want)) return badBody("status must be one of pending, approved, rejected, cancelled, all");
  const rows = [...S.approvals.values()]
    .filter((a) => a.origin === "webdesk" && a.workflowId === "content.publish" && a.toolArgs.clientId === CLIENT_ID && (want === "all" || a.status === want))
    .reverse()
    .map((a) => {
      const mine = a.requestedBy === userId;
      return {
        approvalId: a.id, status: a.status, createdAt: a.createdAt, tenantSlug: a.toolArgs.tenantSlug, siteId: a.toolArgs.siteId,
        itemCount: a.toolArgs.items.length, itemIds: a.toolArgs.items.map((i) => i.itemId), items: a.toolArgs.items.map((i) => ({ itemId: i.itemId, version: i.version })),
        requestedBy: { userId: a.requestedBy, name: a.requestedByName }, requestedByMe: mine,
        canApprove: a.status === "pending" && (!mine || a.toolArgs.items.length === 1), executionStatus: a.executionStatus === "not_applicable" ? null : a.executionStatus ?? null,
      };
    });
  return R(200, { requests: rows });
}

function withdraw(S, userId, id) {
  const a = S.approvals.get(id);
  if (!a || a.origin !== "webdesk" || a.workflowId !== "content.publish" || a.toolArgs.clientId !== CLIENT_ID) return R(404, { error: "approval_not_found", reason: "approval_not_found" });
  if (a.requestedBy !== userId) return forbidden();
  if (a.status !== "pending") return R(409, { error: "approval_not_pending: only a pending publish request can be withdrawn", reason: "approval_not_pending" });
  a.status = "cancelled";
  a.decidedAt = new Date().toISOString();
  return R(200, { approvalId: id, status: "cancelled" });
}

// ── PV4-08: the client Conversation BFF (FRONTEND-BFF-CONTRACT §29a), for e2e/portal-conversation.spec.ts ──────────────
// Only what that spec drives: the thread list, a thread read (which marks it read), and a post. A VIEWER-capability contact
// may post (PV-D24: no signing check). The staff side is not served: a staff reply is injected with `/__stub/staff-reply`
// (server.mjs), which is the only way a second party exists in this stub. Edit and retract (PATCH / DELETE .../messages/:id)
// are NOT stubbed: the demo-mode spec (e2e/portal.spec.ts) drives them against the demo store, which enforces the 15-minute window.
const CONV_RE = /^\/api\/([^/]+)\/portal\/conversation(?:\/([^/]+))?(?:\/(messages))?$/;
export const isPortalConversationPath = (pathname) => CONV_RE.test(pathname);

export const CONV_THREAD_ID = "5a1c0000-0000-4000-8000-0000000000a1";
export const CONV_GENERAL_ID = "5a1c0000-0000-4000-8000-0000000000a2";

function seedConversation() {
  const t0 = Date.parse("2026-10-01T09:00:00Z");
  return {
    seq: 0,
    threads: [
      { id: CONV_GENERAL_ID, projectId: null, projectName: null, general: true, subject: null, status: "open", createdSide: "staff", createdAt: new Date(t0).toISOString(), unread: 0 },
      { id: CONV_THREAD_ID, projectId: "5a1c0000-0000-4000-8000-0000000000b1", projectName: "Website relaunch", general: false, subject: "Homepage copy", status: "open", createdSide: "client", createdAt: new Date(t0 + 1000).toISOString(), unread: 0 },
    ],
    messages: [
      { id: "m-seed-1", threadId: CONV_THREAD_ID, authorId: "wd-client-a", authorName: "Dana Editor", authorSide: "client", body: "Can we change the homepage headline before Friday?", createdAt: new Date(t0 + 2000).toISOString() },
    ],
  };
}

const unreadThreads = (S) => S.portal.conv.threads.filter((t) => t.unread > 0).length;

function threadView(S, t, withUnread) {
  const last = S.portal.conv.messages.filter((m) => m.threadId === t.id).map((m) => m.createdAt).sort().at(-1) ?? t.createdAt;
  return {
    id: t.id, clientId: CLIENT_ID, clientName: CLIENT_NAME, projectId: t.projectId, projectName: t.projectName, general: t.general,
    subject: t.subject, status: t.status, createdSide: t.createdSide, lastMessageAt: last, createdAt: t.createdAt,
    ...(withUnread ? { unreadCount: t.unread } : {}),
  };
}

export function handlePortalConversation(S, { method, pathname, body, userId }) {
  if (!PORTAL_USERS[userId]) return { status: 403, json: { error: "not a portal client" } };
  const [, , id, messages] = pathname.match(CONV_RE);
  const conv = S.portal.conv;
  if (!id && method === "GET") {
    return { status: 200, json: { threads: conv.threads.map((t) => threadView(S, t, true)), canUseGeneral: true } };
  }
  const thread = conv.threads.find((t) => t.id === id);
  if (!thread) return { status: 404, json: { error: "conversation not found" } };
  if (!messages && method === "GET") {
    thread.unread = 0; // opening a thread marks it read
    return {
      status: 200,
      json: {
        thread: threadView(S, thread, false),
        messages: conv.messages.filter((m) => m.threadId === thread.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((m) => ({
          id: m.id, threadId: m.threadId, authorId: m.authorId, authorName: m.authorName, authorSide: m.authorSide, body: m.body,
          createdAt: m.createdAt, mine: m.authorId === userId,
          attachments: [],
        })),
      },
    };
  }
  if (messages && method === "POST") {
    if (thread.status === "closed") return { status: 409, json: { error: "thread is closed" } };
    const text = typeof body?.body === "string" ? body.body.trim() : "";
    if (!text || text.length > 10_000) return { status: 400, json: { error: "body must be 1 to 10,000 characters", field: "body" } };
    const m = { id: `m-${++conv.seq}`, threadId: thread.id, authorId: userId, authorName: PORTAL_USERS[userId].name, authorSide: "client", body: text, createdAt: new Date().toISOString() };
    conv.messages.push(m);
    return { status: 201, json: { id: m.id, threadId: thread.id, createdAt: m.createdAt, attachmentIds: [] } };
  }
  return { status: 405, json: { error: "not stubbed" } };
}

/** `POST /__stub/staff-reply {threadId?, body, by?}`: a staff member answers. The thread's unread count rises, as the real BFF's would. */
export function staffReply(S, { threadId = CONV_THREAD_ID, body, by = "Made Prabowo" }) {
  const conv = S.portal.conv;
  const thread = conv.threads.find((t) => t.id === threadId);
  if (!thread) return { ok: false };
  const m = { id: `m-${++conv.seq}`, threadId, authorId: "stub-staff-made", authorName: by, authorSide: "staff", body, createdAt: new Date().toISOString() };
  conv.messages.push(m);
  thread.unread += 1;
  return { ok: true, id: m.id };
}

/** `POST /__stub/conversation-state`: what the spec asserts the server received. */
export const conversationSnapshot = (S) => ({ messages: S.portal.conv.messages.map((m) => ({ ...m })), unreadThreads: unreadThreads(S) });
