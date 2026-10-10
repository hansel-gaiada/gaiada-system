// WSK-44 — the stubbed WSK-59 BFF, as a pure in-memory model. TEST FIXTURE ONLY: nothing under `src/`
// imports this, so none of it can reach a shipped code path (the brief's rule). `server.mjs` serves it
// over HTTP to a real `next start`; `wd.test.mjs`-style unit use is possible because it has no I/O.
//
// IT MATCHES THE SPEC, NOT THE UI. Every response shape below is transcribed from
// docs/plans/2026-10-10-webdesk-write-plane-design.md §3.2 (writes), §3.4 (RFC 9457 problems),
// §4 (read projections), §6 (the approval's tool_args), and the routes WSK-59 did NOT build are marked
// PROPOSED. WSK-44b re-verified this file against the REAL controller (platform-nest
// `webdesk-content-ui-contract.test.ts`) and brought it to the real behaviour where it differed: a
// withdrawn approval is `cancelled` (and stays), `GET …/publish-requests` exists, `lint` is always
// `{placeholders:{…}}`, and a missing version is a 404. Keep this file boring and literal, never "helpful".
//
// Fixtures are the real compositions from the gaiada.com bundle (`compositions/*.json`, copied
// read-only from the site repo's `scripts/webdesk/compositions/`): service (the shared page shape),
// navigation (per-locale singleton, locale-neutral members, list of objects keyed by itemKey),
// token-registry and company (locale-neutral singletons, `ui.readOnly` members), redirect.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const comp = (k) => JSON.parse(fs.readFileSync(path.join(HERE, "compositions", `${k}.json`), "utf8"));

export const COMPANY = "co-agency"; // the demo company that owns Web Dev (dept-1)
export const TENANT = "gaiada";
export const SITE = "site-gaiada-com";
const PROBLEM = "https://webdesk.gaiada.online/errors/";

// Who may do what. Derived from the x-user-id the UI forwards (the demo identity the e2e logged in as).
//   demo-hansel / dept-manager -> publisher (read, write, request_publish, unpublish, delete)
//   gede-ic                    -> viewer    (read only: every write is a Cerbos 403)
//   anything else              -> none      (reads are 403 too)
const ROLE = { "demo-hansel": "publisher", "dept-manager": "publisher", "gede-ic": "viewer" };
export const roleOf = (userId) => ROLE[userId] ?? "none";

const sha = (v) => crypto.createHash("sha256").update(canonical(v)).digest("hex");
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// ── lint (placeholders: tokens {{X}} and markers [CONFIRM: …] / [CLIENT: …]) ───────────────────────
function stringLeaves(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringLeaves(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => stringLeaves(x, out));
  return out;
}
function lintOf(composition, blocks) {
  if (!composition.lint?.placeholders) return { placeholders: { unresolvedTokens: [], markers: {} } };
  const text = stringLeaves(blocks).join("\n");
  const tokens = [...new Set([...text.matchAll(/\{\{[A-Z0-9_]+\}\}/g)].map((m) => m[0]))];
  const markers = {};
  for (const r of composition.lint.placeholders) {
    if (r.kind !== "marker") continue;
    markers[r.label] = text.split(`${r.open}`).length - 1;
  }
  return { placeholders: { unresolvedTokens: tokens, markers } };
}

// ── validation (a faithful subset of payload/vocabulary/item-fields.ts) ─────────────────────────────
const seg = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");
function validateField(def, v, ptr, out, depth = 1) {
  if (v === undefined || v === null) {
    if (def.required) out.push({ path: ptr, message: `${def.name} is required`, expected: def.primitive });
    return;
  }
  if (def.multiple) {
    if (!Array.isArray(v)) { out.push({ path: ptr, message: "expected an array (field is \"multiple\")" }); return; }
    v.forEach((x, i) => validateOne(def, x, `${ptr}/${i}`, out, depth));
    if (def.primitive === "group" && def.itemKey) {
      const seen = new Map();
      v.forEach((x, i) => {
        const k = x && typeof x === "object" ? x[def.itemKey] : undefined;
        if (typeof k !== "string") return;
        if (seen.has(k)) out.push({ path: `${ptr}/${i}/${seg(def.itemKey)}`, message: `duplicate itemKey "${def.itemKey}" value "${k}" (first used at index ${seen.get(k)})` });
        else seen.set(k, i);
      });
    }
    return;
  }
  validateOne(def, v, ptr, out, depth);
}
function validateOne(def, v, ptr, out, depth) {
  const bad = (m) => out.push({ path: ptr, message: m });
  switch (def.primitive) {
    case "text": case "markdown": if (typeof v !== "string") bad("expected a string"); break;
    case "boolean": if (typeof v !== "boolean") bad("expected a boolean (JSON true/false)"); break;
    case "number": if (typeof v !== "number" || !Number.isFinite(v)) bad("expected a finite number"); break;
    case "select": if (typeof v !== "string") bad("expected a string"); else if (def.options && !def.options.includes(v)) bad(`"${v}" is not one of: ${def.options.join(", ")}`); break;
    case "group": {
      if (!v || typeof v !== "object" || Array.isArray(v)) { bad("expected an object (group)"); break; }
      const known = new Set(def.fields.map((f) => f.name));
      for (const k of Object.keys(v)) if (!known.has(k)) out.push({ path: `${ptr}/${seg(k)}`, message: `unknown key "${k}" (a group is closed)` });
      for (const f of def.fields) validateField(f, v[f.name], `${ptr}/${seg(f.name)}`, out, depth + 1);
      break;
    }
    default: break;
  }
}
function validateItem(composition, fields) {
  const out = [];
  for (const d of composition.fields ?? []) validateField(d, fields?.[d.name], `/blocks/0/props/${seg(d.name)}`, out);
  return out;
}

// ── seed ───────────────────────────────────────────────────────────────────────────────────────────
const T0 = "2026-10-08T09:00:00.000Z";
const T1 = "2026-10-09T09:30:00.000Z";
const T2 = "2026-10-10T08:15:00.000Z";

const SERVICE_SEO_V = (n) => ({
  url: "/services/seo/",
  source_path: "content/en/services/seo.md",
  template: "service",
  section: "service",
  language: "en-GB",
  h1: n === 1 ? "SEO Agency Bali" : n === 2 ? "SEO Agency in Bali" : "SEO Agency in Bali for Hotels",
  primary_keyword: "seo agency bali",
  phase: "L",
  schema: ["Service", "OfferCatalog", "FAQPage", "AggregateRating"],
  hreflang_id: "/id/services/seo/",
  author: "[CONFIRM: author name and role]",
  last_updated: "{{PUBLISH_DATE}}",
  publish_ready: false,
  schema_notes: "Service:\n  name: \"SEO\"\n  provider: \"Gaia Digital Agency\"\n",
  image_alt_texts: ["SEO Agency Bali team reviewing Google Search Console data for a hotel client in Ubud", "Five-step SEO process diagram used by Gaia Digital Agency for Bali hospitality clients"],
  visibility: "shown",
  plan: { action: "SHOW", to: "", why: "Core service page" },
  body: `# ${n === 1 ? "SEO Agency Bali" : "SEO Agency in Bali"}\n\nGaia Digital Agency is an SEO agency in Bali that helps hotels, villas and restaurants. [CLIENT: confirm results claim]\n\n## What we do\n\n- Technical SEO\n- Content strategy\n- Local SEO\n`,
});

function fieldsBlock(props) { return [{ type: "fields", props }]; }

const NAV_EN = {
  primary: [
    { label: "Services", hub: "All services", url: "/services/", children: ["/services/seo/", "/services/branding/"] },
    { label: "Work", hub: "All case studies", url: "/work/", children: ["/work/villa-ubud/"] },
    { label: "About", hub: "About Gaia", url: "/about/", children: [] },
  ],
  cta: { label: "Get your free audit", url: "/free-audit/" },
};
const NAV_ID = {
  primary: [
    { label: "Layanan", hub: "Semua layanan", url: "/services/", children: ["/stale/"] },
    { label: "Karya", hub: "Semua studi kasus", url: "/work/", children: ["/work/villa-ubud/"] },
    { label: "Tentang", hub: "Tentang Gaia", url: "/about/", children: [] },
  ],
  cta: { label: "Dapatkan audit gratis", url: "/free-audit/" },
};

const TOKENS = {
  instructions: "Fill the value of every token from the factsheet; the site substitutes them at build time.",
  tokens: [
    { token: "{{PUBLISH_DATE}}", value: "", occurrences: 315, pages: ["/", "/services/seo/"], page_count: 315, source: "operator" },
    { token: "{{RESULT_1_METRIC}}", value: "", occurrences: 12, pages: ["/work/villa-ubud/"], page_count: 4, source: "factsheet" },
  ],
};
const COMPANY_FIELDS = {
  name: "Gaia Digital Agency", legalName: "PT Gaia Digital Agency", domain: "gaiada.com",
  address: { street: "Jl. Raya Sanur 1", locality: "Denpasar", region: "Bali", country: "ID", full: "Jl. Raya Sanur 1, Denpasar, Bali, ID" },
  phone: "+62 361 000 000", email: "hello@gaiada.com",
  people: [{ name: "Wayan Putra", role: "Founder", email: "wayan@gaiada.com" }],
  foundingDate: "2014-03-01", founder: "Wayan Putra", certifications: "", aggregateRating: "",
  sameAs: ["https://www.linkedin.com/company/gaiada"], areaServed: ["Bali"], languages: ["en", "id"], defaultLocale: "en", priceCurrency: ["IDR"],
  boilerplate_short: "Gaia Digital Agency is a Bali digital agency.",
};

export function seed() {
  const compositions = {
    service: comp("service"), navigation: comp("navigation"), "token-registry": comp("token-registry"), company: comp("company"),
  };
  const items = new Map();
  const add = (o) => {
    const versions = o.versions.map((v) => ({ n: v.n, contentHash: sha({ blocks: v.blocks, seo: v.seo }), createdAt: v.at, createdBy: v.by, attribution: { pk: "human" }, note: v.note ?? null, blocks: v.blocks, seo: v.seo }));
    items.set(o.id, { itemId: o.id, collectionKey: o.collection, locale: o.locale, slug: o.slug, groupId: o.groupId, versions, publishedVersion: o.published ?? null, publishState: o.state ?? "draft", publishAt: null, unpublishAt: null, deletedAt: o.deletedAt ?? null });
  };
  add({ id: "itm-service-seo-en", collection: "service", locale: "en", slug: "service.seo", groupId: "grp-service-seo", published: 2, state: "published",
    versions: [
      { n: 1, at: T0, by: "demo-hansel", note: "import", blocks: fieldsBlock(SERVICE_SEO_V(1)), seo: { title: "SEO Agency Bali | Gaia Digital Agency", description: "SEO Agency Bali for hotels, villas and restaurants." } },
      { n: 2, at: T1, by: "demo-hansel", note: "tighten H1", blocks: fieldsBlock(SERVICE_SEO_V(2)), seo: { title: "SEO Agency Bali | Gaia Digital Agency", description: "SEO Agency Bali for hotels, villas and restaurants." } },
      { n: 3, at: T2, by: "dept-manager", note: "add hotel angle", blocks: fieldsBlock(SERVICE_SEO_V(3)), seo: { title: "SEO Agency Bali | Gaia Digital Agency", description: "SEO Agency Bali for hotels, villas and restaurants. Free audit." } },
    ] });
  add({ id: "itm-service-seo-id", collection: "service", locale: "id", slug: "service.seo", groupId: "grp-service-seo",
    versions: [{ n: 1, at: T0, by: "demo-hansel", note: "import", blocks: fieldsBlock({ ...SERVICE_SEO_V(1), url: "/id/layanan/seo/", source_path: "content/id/layanan/seo.md", language: "id-ID", h1: "Agensi SEO Bali", hreflang_id: undefined, body: "# Agensi SEO Bali\n\nGaia Digital Agency adalah agensi SEO di Bali.\n" }), seo: { title: "Agensi SEO Bali | Gaia Digital Agency" } }] });
  add({ id: "itm-service-local-seo-en", collection: "service", locale: "en", slug: "service.local-seo", groupId: "grp-service-local-seo",
    versions: [{ n: 1, at: T1, by: "demo-hansel", note: null, blocks: fieldsBlock({ ...SERVICE_SEO_V(1), url: "/services/local-seo/", source_path: "content/en/services/local-seo.md", h1: "Local SEO Bali", body: "# Local SEO Bali\n" }), seo: { title: "Local SEO Bali" } }] });
  add({ id: "itm-service-web-design-en", collection: "service", locale: "en", slug: "service.web-design", groupId: "grp-service-web-design", published: 1, state: "published",
    versions: [{ n: 1, at: T0, by: "demo-hansel", note: "import", blocks: fieldsBlock({ ...SERVICE_SEO_V(1), url: "/services/web-design/", source_path: "content/en/services/web-design.md", h1: "Web Design Bali", body: "# Web Design Bali\n" }), seo: { title: "Web Design Bali" } }] });
  add({ id: "itm-service-old-en", collection: "service", locale: "en", slug: "service.old-draft", groupId: "grp-service-old", deletedAt: T2,
    versions: [{ n: 1, at: T0, by: "demo-hansel", note: null, blocks: fieldsBlock({ ...SERVICE_SEO_V(1), url: "/services/old/", source_path: "content/en/services/old.md", h1: "Old draft", body: "# Old\n" }), seo: { title: "Old draft" } }] });
  add({ id: "itm-nav-en", collection: "navigation", locale: "en", slug: "navigation", groupId: "grp-nav", published: 1, state: "published",
    versions: [{ n: 1, at: T0, by: "demo-hansel", note: "import", blocks: fieldsBlock(NAV_EN), seo: {} }] });
  add({ id: "itm-nav-id", collection: "navigation", locale: "id", slug: "navigation", groupId: "grp-nav",
    versions: [{ n: 1, at: T0, by: "demo-hansel", note: "import", blocks: fieldsBlock(NAV_ID), seo: {} }] });
  add({ id: "itm-tokens-en", collection: "token-registry", locale: "en", slug: "token-registry", groupId: "grp-tokens", published: 1, state: "published",
    versions: [{ n: 1, at: T0, by: "demo-hansel", note: "import", blocks: fieldsBlock(TOKENS), seo: {} }] });
  add({ id: "itm-company-en", collection: "company", locale: "en", slug: "company", groupId: "grp-company", published: 1, state: "published",
    versions: [{ n: 1, at: T0, by: "demo-hansel", note: "import", blocks: fieldsBlock(COMPANY_FIELDS), seo: {} }] });

  return {
    compositions,
    items,
    approvals: new Map(),
    build: null,
    stagingStale: false,
    seq: 0,
    cfg: { approvalReadForbidden: false, forbidden: false, unavailable: false, moduleDisabled: false, delayMs: 0, buildStatusServed: true, lintUnavailable: false, ambiguous: null, rebuildNotConfigured: false, drift: null, forceIssues: null, unavailableOnce: 0 },
    log: [],
  };
}

// ── projections ──────────────────────────────────────────────────────────────────────────────────
const head = (it) => it.versions[it.versions.length - 1];
const itemRef = (it) => ({
  itemId: it.itemId, collectionKey: it.collectionKey, locale: it.locale, slug: it.slug, localizationGroupId: it.groupId,
  headVersion: head(it).n, publishedVersion: it.publishedVersion, publishState: it.publishState,
  publishAt: it.publishAt, unpublishAt: it.unpublishAt, deletedAt: it.deletedAt, updatedAt: head(it).createdAt,
});
function titleOf(S, it) {
  const c = S.compositions[it.collectionKey];
  const v = head(it);
  const f = v.blocks[0]?.props ?? {};
  const tf = c.ui?.titleField;
  return v.seo?.title || (tf && typeof f[tf] === "string" ? f[tf] : null) || null;
}
const summary = (S, it) => ({
  itemId: it.itemId, slug: it.slug, locale: it.locale, localizationGroupId: it.groupId, title: titleOf(S, it),
  headVersion: head(it).n, publishedVersion: it.publishedVersion, publishState: it.publishState,
  publishAt: it.publishAt, unpublishAt: it.unpublishAt, deletedAt: it.deletedAt, updatedAt: head(it).createdAt,
  headCreatedAt: head(it).createdAt, headCreatedBy: head(it).createdBy,
  pendingChanges: it.publishedVersion === null || it.publishedVersion !== head(it).n,
});

export const tenantList = (S, company) => company === COMPANY ? {
  tenants: [{
    slug: TENANT, status: "active", defaultLocale: "en", locales: ["en", "id"],
    sites: [{
      siteId: SITE, name: "gaiada.com", kind: "static",
      environments: [
        { envId: "env-staging", name: "staging", domain: "24-pyevq.gaiada.com", status: "active" },
        { envId: "env-production", name: "production", domain: "gaiada.com", status: "pending" },
      ],
    }],
  }],
} : { tenants: [] };

const collectionsBody = (S) => ({
  collections: Object.entries(S.compositions).map(([key, composition]) => {
    const its = [...S.items.values()].filter((i) => i.collectionKey === key && !i.deletedAt);
    const byLocale = {};
    for (const i of its) byLocale[i.locale] = (byLocale[i.locale] ?? 0) + 1;
    return {
      key, composition, vocabularyVersion: "1.1.0",
      counts: { items: its.length, byLocale, live: its.filter((i) => i.publishState === "published").length, pendingChanges: its.filter((i) => summary(S, i).pendingChanges).length },
      updatedAt: its.map((i) => head(i).createdAt).sort().pop() ?? T0,
    };
  }),
});

function detailBody(S, it, which) {
  let v;
  if (which === "live") v = it.versions.find((x) => x.n === it.publishedVersion);
  else if (which === "head" || which === undefined) v = head(it);
  else v = it.versions.find((x) => x.n === Number(which));
  if (!v) return null;
  const c = S.compositions[it.collectionKey];
  return {
    item: itemRef(it),
    version: { n: v.n, contentHash: v.contentHash, createdAt: v.createdAt, createdBy: v.createdBy, attribution: v.attribution, note: v.note, blocks: v.blocks, seo: v.seo },
    live: it.publishedVersion === null ? null : (() => { const l = it.versions.find((x) => x.n === it.publishedVersion); return { n: l.n, contentHash: l.contentHash, createdAt: l.createdAt, createdBy: l.createdBy, attribution: l.attribution, note: l.note, blocks: l.blocks, seo: l.seo }; })(),
    group: [...S.items.values()].filter((g) => g.groupId === it.groupId && !g.deletedAt).map((g) => ({
      locale: g.locale, itemId: g.itemId, slug: g.slug, headVersion: head(g).n, publishedVersion: g.publishedVersion, publishState: g.publishState,
    })),
    lint: S.cfg.lintUnavailable
      // `content-reads.service.ts`: when the collection's stored composition is invalid the lint cannot RUN: the report is
      // empty AND `unavailable` carries the reason. An empty list here is not a finding.
      ? { placeholders: { unresolvedTokens: [], markers: {} }, unavailable: "the collection's stored composition is invalid" }
      : lintOf(c, v.blocks),
  };
}

// ── HTTP-shaped helpers ──────────────────────────────────────────────────────────────────────────
const R = (status, json) => ({ status, json });
const problem = (status, slug, title, extra = {}) => R(status, { type: `${PROBLEM}${slug}`, title, status, instance: "/stub", requestId: "stub-req", ...extra });

// The BFF's own refusals use platform-nest's `{ error }` shape (HttpErrorFilter), not a problem document.
const forbidden = () => R(403, { error: "forbidden" });

// 502 `webdesk_ambiguous` (cfg.ambiguous = "drop" | "land"): a write whose outcome the BFF could not confirm. "drop" = the
// write did NOT reach Zone B (`not_observed`), "land" = it DID apply but could not be reconciled (`reconcile_failed`).
const ambiguousWrite = (S, apply) => {
  if (!S.cfg.ambiguous) return null;
  const lands = S.cfg.ambiguous === "land";
  if (lands) apply();
  return R(502, { error: "webdesk_ambiguous", reason: lands ? "reconcile_failed" : "not_observed" });
};

export function handleWebdesk(S, { method, pathname, query, body, userId, company }) {
  const role = roleOf(userId);
  const sub = pathname.replace(/^\/api\/[^/]+\/modules\/webdev\/content/, "") || "/";

  if (S.cfg.moduleDisabled) return R(404, { error: "module webdev not enabled for this company" });
  if (S.cfg.forbidden) return forbidden();
  if (S.cfg.unavailable) return R(503, { error: "editorial_unavailable" });
  if (S.cfg.unavailableOnce > 0) { S.cfg.unavailableOnce -= 1; return R(503, { error: "editorial_unavailable" }); }
  if (role === "none") return forbidden();
  const isWrite = method !== "GET";
  if (isWrite && role === "viewer") return forbidden();

  // tenant.list
  if (sub === "/sites" && method === "GET") {
    const b = tenantList(S, company);
    if (S.cfg.drift === "sites") delete b.tenants[0]?.defaultLocale; // a contract drift on purpose
    return R(200, b);
  }

  const m = sub.match(/^\/sites\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!m) return R(404, { error: `Cannot ${method} ${pathname}` });
  const [, t, s, rest = ""] = m;
  if (company !== COMPANY || t !== TENANT || s !== SITE) return problem(404, "site-not-found", "Site not found");

  if (rest === "/collections" && method === "GET") return R(200, collectionsBody(S));

  let mm;
  if ((mm = rest.match(/^\/collections\/([^/]+)\/items$/))) {
    const key = mm[1];
    const composition = S.compositions[key];
    if (!composition) return problem(404, "collection-not-found", "Collection not found");
    if (method === "GET") {
      let its = [...S.items.values()].filter((i) => i.collectionKey === key);
      const state = query.get("state");
      if (state === "deleted") its = its.filter((i) => i.deletedAt);
      else its = its.filter((i) => !i.deletedAt);
      if (query.get("locale")) its = its.filter((i) => i.locale === query.get("locale"));
      if (state === "draft") its = its.filter((i) => i.publishState === "draft");
      if (state === "live") its = its.filter((i) => i.publishState === "published");
      if (state === "scheduled" || state === "unpublished") its = its.filter((i) => i.publishState === state);
      if (state === "pending") its = its.filter((i) => summary(S, i).pendingChanges);
      const q = (query.get("q") ?? "").toLowerCase();
      if (q) its = its.filter((i) => i.slug.toLowerCase().includes(q) || (titleOf(S, i) ?? "").toLowerCase().includes(q));
      its.sort((a, b) => a.slug.localeCompare(b.slug) || a.locale.localeCompare(b.locale) || a.itemId.localeCompare(b.itemId));
      const limit = Math.min(Number(query.get("limit") ?? 100), 100);
      const offset = Number(query.get("cursor") ?? 0);
      const pageItems = its.slice(offset, offset + limit);
      const hasMore = offset + limit < its.length;
      return R(200, { items: pageItems.map((i) => summary(S, i)), page: { cursor: hasMore ? String(offset + limit) : null, hasMore, limit } });
    }
    if (method === "POST") return createItem(S, key, composition, body, userId);
  }

  if ((mm = rest.match(/^\/items\/([^/]+)$/))) {
    const it = S.items.get(mm[1]);
    if (!it) return problem(404, "item-not-found", "Item not found");
    if (method === "GET") {
      const b = detailBody(S, it, query.get("version") ?? "head");
      if (!b) return problem(404, "version-not-found", "Version not found");
      return R(200, b);
    }
    if (method === "PUT") return ambiguousWrite(S, () => updateItem(S, it, body, userId)) ?? updateItem(S, it, body, userId);
  }
  if ((mm = rest.match(/^\/items\/([^/]+)\/versions$/)) && method === "GET") {
    const it = S.items.get(mm[1]);
    if (!it) return problem(404, "item-not-found", "Item not found");
    return R(200, { versions: [...it.versions].reverse().map((v) => ({ version: v.n, contentHash: v.contentHash, createdAt: v.createdAt, createdBy: v.createdBy, attribution: v.attribution, note: v.note })), page: { cursor: null, hasMore: false, limit: 100 } });
  }
  if ((mm = rest.match(/^\/items\/([^/]+)\/versions\/(\d+)$/)) && method === "GET") {
    const it = S.items.get(mm[1]);
    if (!it) return problem(404, "item-not-found", "Item not found");
    const v = it.versions.find((x) => x.n === Number(mm[2]));
    if (!v) return problem(404, "version-not-found", "Version not found");
    return R(200, { n: v.n, version: v.n, contentHash: v.contentHash, createdAt: v.createdAt, createdBy: v.createdBy, attribution: v.attribution, note: v.note, blocks: v.blocks, seo: v.seo });
  }
  if ((mm = rest.match(/^\/items\/([^/]+)\/(restore|unpublish|delete)$/)) && method === "POST") {
    const it = S.items.get(mm[1]);
    if (!it) return problem(404, "item-not-found", "Item not found");
    const run = () => (mm[2] === "restore" ? restoreItem(S, it, body, userId) : mm[2] === "unpublish" ? unpublishItem(S, it, body) : deleteItem(S, it, body));
    return ambiguousWrite(S, run) ?? run();
  }

  if (rest === "/publish-requests" && method === "POST") return requestPublish(S, body, userId);
  if (rest === "/publish-requests" && method === "GET") {
    // WSK-44b: the caller's OWN publish/schedule approvals for this site (authorised as request_publish).
    if (role === "viewer") return forbidden();
    const want = query.get("status") ?? "pending";
    return R(200, {
      requests: [...S.approvals.values()]
        .filter((a) => a.origin === "webdesk" && a.requestedBy === userId && (a.workflowId === "content.publish" || a.workflowId === "content.schedule") && (want === "all" || a.status === want))
        .reverse()
        .map((a) => ({ approvalId: a.id, status: a.status, createdAt: a.createdAt, itemIds: a.toolArgs.items.map((i) => i.itemId), executionStatus: a.executionStatus ?? null })),
    });
  }
  if ((mm = rest.match(/^\/publish-requests\/([^/]+)\/withdraw$/)) && method === "POST") {
    // WSK-59: the REQUESTER cancels their own pending request; the row stays, `cancelled` (not `rejected`).
    const a = S.approvals.get(mm[1]);
    if (!a || a.origin !== "webdesk" || (a.workflowId !== "content.publish" && a.workflowId !== "content.schedule")) return R(404, { error: "approval_not_found", reason: "approval_not_found" });
    if (a.requestedBy !== userId) return forbidden();
    if (a.status !== "pending") return R(409, { error: "approval_not_pending: only a pending publish request can be withdrawn", reason: "approval_not_pending" });
    a.status = "cancelled";
    a.decidedAt = nowIso();
    return R(200, { approvalId: a.id, status: "cancelled" });
  }
  if (rest === "/rebuild-requests" && method === "POST") {
    // WSK-60. A site with no staging rebuild target is refused up front, before any approval is filed.
    if (S.cfg.rebuildNotConfigured) return R(503, { error: "webdesk_not_configured: no staging rebuild target is configured for this site", reason: "webdesk_not_configured" });
    const id = `ap-${(++S.seq).toString(16).padStart(4, "0")}-rebuild`;
    S.approvals.set(id, approvalRow(S, id, "content.rebuild", userId, { tenantSlug: TENANT, siteId: SITE, items: [], rebuild: "staging" }, "Rebuild gaiada.com staging"));
    return R(202, { approvalId: id });
  }
  if (rest === "/build-status" && method === "GET") {
    // PROPOSED (not in WSK-59).
    if (!S.cfg.buildStatusServed) return R(404, { error: `Cannot GET ${pathname}` });
    return R(200, { build: S.build, stagingStale: S.stagingStale });
  }
  if (rest === "/media" && method === "GET") return R(200, { assets: [], page: { cursor: null, hasMore: false, limit: 100 } });

  return R(404, { error: `Cannot ${method} ${pathname}` });
}

// ── writes ───────────────────────────────────────────────────────────────────────────────────────
const SLUG = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const nowIso = () => new Date().toISOString();

function writeResult(S, it, v, unchanged) {
  return R(200, { item: itemRef(it), version: { version: v.n, contentHash: v.contentHash, createdAt: v.createdAt }, unchanged, lint: lintOf(S.compositions[it.collectionKey], v.blocks), replayed: false });
}

function contentFrom(composition, body) {
  const fields = body.fields ?? {};
  const blocks = composition.fields ? [{ type: "fields", props: fields }, ...(body.blocks ?? [])] : (body.blocks ?? []);
  return { fields, blocks, seo: body.seo ?? {} };
}

function checkIssues(S, composition, fields) {
  if (S.cfg.forceIssues) { const f = S.cfg.forceIssues; S.cfg.forceIssues = null; return f; }
  const issues = validateItem(composition, fields);
  return issues.length ? issues : null;
}

function createItem(S, key, composition, body, userId) {
  if (!body || typeof body !== "object") return problem(400, "invalid-request", "Invalid request");
  for (const k of ["tenantSlug", "siteId", "itemId"]) if (k in body) return problem(400, "invalid-request", `The body may not contain ${k}`);
  const { locale, slug, twinOf = null } = body;
  if (typeof slug !== "string" || !SLUG.test(slug) || slug.length > 200) return problem(422, "composition-violation", "Invalid slug", { issues: [{ path: "/slug", message: "slug must match ^[a-z0-9]+(?:[.-][a-z0-9]+)*$" }] });
  if (!["en", "id"].includes(locale)) return problem(422, "composition-violation", "Invalid locale", { issues: [{ path: "/locale", message: "locale must be one of en, id" }] });
  if (composition.localized === false && locale !== "en") return problem(422, "composition-violation", "Collection is locale-neutral", { issues: [{ path: "/locale", message: "this collection exists only in en" }] });
  const peers = [...S.items.values()].filter((i) => i.collectionKey === key && !i.deletedAt);
  let groupId;
  if (twinOf) {
    const twin = S.items.get(twinOf);
    if (!twin || twin.collectionKey !== key) return problem(404, "item-not-found", "Twin not found");
    if (peers.some((i) => i.groupId === twin.groupId && i.locale === locale)) return problem(409, "twin-locale-taken", "Twin locale taken");
    groupId = twin.groupId;
  } else {
    if (peers.some((i) => i.slug === slug && i.locale === locale)) return problem(409, "slug-taken", "Slug taken");
    if (composition.singleton && peers.some((i) => i.locale === locale)) return problem(409, "singleton-exists", "Singleton exists");
    groupId = `grp-${crypto.randomUUID().slice(0, 8)}`;
  }
  const { fields, blocks, seo } = contentFrom(composition, body);
  const issues = checkIssues(S, composition, fields);
  if (issues) return problem(422, "composition-violation", "Composition violation", { issues });
  const id = `itm-${crypto.randomUUID().slice(0, 8)}`;
  const v = { n: 1, contentHash: sha({ blocks, seo }), createdAt: nowIso(), createdBy: userId, attribution: { pk: "human" }, note: body.note ?? null, blocks, seo };
  const it = { itemId: id, collectionKey: key, locale, slug, groupId, versions: [v], publishedVersion: null, publishState: "draft", publishAt: null, unpublishAt: null, deletedAt: null };
  S.items.set(id, it);
  const r = writeResult(S, it, v, false);
  r.status = 201;
  return r;
}

function conflict(it) {
  const h = head(it);
  return problem(409, "version-conflict", "Version conflict", { currentHeadVersion: h.n, currentContentHash: h.contentHash, updatedAt: h.createdAt });
}

function updateItem(S, it, body, userId) {
  if (!body || typeof body !== "object" || !Number.isInteger(body.baseVersion)) return problem(400, "invalid-request", "baseVersion is required");
  for (const k of ["tenantSlug", "siteId", "itemId"]) if (k in body) return problem(400, "invalid-request", `The body may not contain ${k}`);
  if (it.deletedAt) return problem(409, "item-deleted", "Item deleted");
  if (body.baseVersion !== head(it).n) return conflict(it);
  const composition = S.compositions[it.collectionKey];
  const { fields, blocks, seo } = contentFrom(composition, body);
  const issues = checkIssues(S, composition, fields);
  if (issues) return problem(422, "composition-violation", "Composition violation", { issues });
  const hash = sha({ blocks, seo });
  if (hash === head(it).contentHash) return writeResult(S, it, head(it), true);
  const v = { n: head(it).n + 1, contentHash: hash, createdAt: nowIso(), createdBy: userId, attribution: { pk: "human" }, note: body.note ?? null, blocks, seo };
  it.versions.push(v);
  return writeResult(S, it, v, false);
}

function restoreItem(S, it, body, userId) {
  if (!body || !Number.isInteger(body.version) || !Number.isInteger(body.baseVersion)) return problem(400, "invalid-request", "version and baseVersion are required");
  if (it.deletedAt) return problem(409, "item-deleted", "Item deleted");
  if (body.baseVersion !== head(it).n) return conflict(it);
  const old = it.versions.find((x) => x.n === body.version);
  if (!old) return problem(409, "version-not-found", "Version not found");
  const v = { n: head(it).n + 1, contentHash: old.contentHash, createdAt: nowIso(), createdBy: userId, attribution: { pk: "human" }, note: body.note ?? `restore v${old.n}`, blocks: old.blocks, seo: old.seo };
  it.versions.push(v);
  return writeResult(S, it, v, false);
}

function unpublishItem(S, it, body) {
  if (it.publishedVersion === null) return problem(409, "not-live", "Not live");
  if (!body || body.expectedPublishedVersion !== it.publishedVersion) return problem(409, "published-version-changed", "Published version changed");
  it.publishedVersion = null;
  it.publishState = "unpublished";
  S.stagingStale = true; // §9: unpublish has no approval and no automatic rebuild
  return R(200, { item: itemRef(it) });
}

function deleteItem(S, it, body) {
  if (it.publishedVersion !== null) return problem(409, "item-is-live", "Item is live");
  if (!body || body.baseVersion !== head(it).n) return conflict(it);
  it.deletedAt = nowIso();
  return R(200, { item: itemRef(it) });
}

// ── approvals (publish is one WS4 approval, §6) ──────────────────────────────────────────────────
const NAME = { "demo-hansel": "Hansel Tanaka", "dept-manager": "Dewi Manager", "gede-ic": "Gede Ic" };

function approvalRow(S, id, workflowId, userId, toolArgs, reason) {
  return {
    id, workflowId, toolName: workflowId === "content.rebuild" ? "webdesk.content.requestRebuild" : "webdesk.content.requestPublish", toolArgs, impact: "high", reason,
    status: "pending", origin: "webdesk", agentName: null,
    requestedBy: userId, requestedByName: NAME[userId] ?? null, decidedBy: null, decidedByName: null, decidedAt: null,
    createdAt: nowIso(), executionStatus: "not_applicable", executedAt: null, executedBy: null, executionError: null, executionResult: null, executionAttempts: null,
  };
}

function requestPublish(S, body, userId) {
  if (!body || !Array.isArray(body.items) || body.items.length === 0) return problem(400, "invalid-request", "items required");
  const items = [];
  for (const r of body.items) {
    const it = S.items.get(r.itemId);
    if (!it) return problem(404, "item-not-found", "Item not found");
    const v = it.versions.find((x) => x.n === r.version);
    if (!v) return problem(409, "version-not-found", "Version not found");
    items.push({ itemId: it.itemId, version: v.n, contentHash: v.contentHash });
  }
  const id = `ap-${(++S.seq).toString(16).padStart(4, "0")}-publish`;
  S.approvals.set(id, approvalRow(S, id, "content.publish", userId, { tenantSlug: TENANT, siteId: SITE, items, rebuild: "staging" }, `Publish ${items.length} item${items.length === 1 ? "" : "s"} to gaiada.com and rebuild gaiada.com staging`));
  return R(202, { approvalId: id });
}

/** decide an approval: `approve` executes in-band (§6); `fail` = approved but the executor failed. */
export function decideApproval(S, id, outcome, byUserId = "dept-manager") {
  const a = S.approvals.get(id);
  if (!a) return R(404, { error: "approval not found" });
  if (a.status !== "pending") return R(409, { error: "already decided" });
  a.decidedBy = byUserId; a.decidedByName = NAME[byUserId] ?? null; a.decidedAt = nowIso();
  if (outcome === "reject") { a.status = "rejected"; return R(200, { id, status: "rejected" }); }
  a.status = "approved";
  if (outcome === "fail") { a.executionStatus = "failed"; a.executionError = "version-conflict"; return R(200, { id, status: "approved" }); }
  if (outcome === "executing") { a.executionStatus = "executing"; return R(200, { id, status: "approved" }); }
  for (const r of a.toolArgs.items) {
    const it = S.items.get(r.itemId);
    if (!it) continue;
    it.publishedVersion = r.version;
    it.publishState = "published";
  }
  a.executionStatus = "executed"; a.executedAt = nowIso();
  S.build = { approvalId: id, kind: a.workflowId === "content.rebuild" ? "rebuild" : "publish", requestedAt: nowIso(), publishedAt: a.workflowId === "content.rebuild" ? null : nowIso(), state: "rebuilding", stagingUrl: "https://24-pyevq.gaiada.com", verifiedAt: null };
  S.stagingStale = false;
  return R(200, { id, status: "approved" });
}

export function listApprovals(S, query) {
  const origin = query.get("origin");
  const status = query.get("status");
  return [...S.approvals.values()]
    .filter((a) => (!origin || a.origin === origin) && (!status || a.status === status))
    .map((a) => ({ id: a.id, workflow_id: a.workflowId, tool_name: a.toolName, tool_args: a.toolArgs, impact: a.impact, reason: a.reason, status: a.status, origin: a.origin, agent_name: null, requested_by: a.requestedBy, decided_by: a.decidedBy, decided_at: a.decidedAt, created_at: a.createdAt, execution_status: a.executionStatus }));
}

export function setBuild(S, state, stagingStale) {
  if (S.build) { S.build.state = state; S.build.verifiedAt = state === "live" ? nowIso() : null; }
  if (typeof stagingStale === "boolean") S.stagingStale = stagingStale;
}

/** Someone ELSE saves the head (the 409 setup): appends a version authored by another user. */
export function concurrentSave(S, itemId, patchFields, byUserId = "dept-manager") {
  const it = S.items.get(itemId);
  const h = head(it);
  const props = { ...(h.blocks[0]?.props ?? {}), ...patchFields };
  const blocks = [{ type: "fields", props }, ...h.blocks.slice(1)];
  const v = { n: h.n + 1, contentHash: sha({ blocks, seo: h.seo }), createdAt: nowIso(), createdBy: byUserId, attribution: { pk: "human" }, note: "concurrent edit", blocks, seo: h.seo };
  it.versions.push(v);
  return itemRef(it);
}
