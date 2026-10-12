import "server-only";
// WSK-44 — the ONE module through which the Website workspace reads WebDesk content.
//
//   BFF (WSK-59, `platform-nest/src/modules/webdev/webdesk-content.controller.ts` — BUILT; FRONTEND-BFF-CONTRACT §27):
//     GET  /api/:company/modules/webdev/content/sites
//     GET  …/sites/:tenantSlug/:siteId/collections
//     GET  …/sites/:tenantSlug/:siteId/collections/:collectionKey/items[?locale&state&q&cursor&limit]
//     GET  …/sites/:tenantSlug/:siteId/items/:itemId[?version=head|live|<n>]
//     GET  …/sites/:tenantSlug/:siteId/items/:itemId/versions[/:n]
//     GET  …/sites/:tenantSlug/:siteId/publish-requests[?status=…]   (WSK-44b: the caller's OWN requests)
//   existing (core/automation-approvals.controller.ts; needs `automation_approval:read`, so a requester
//   without it gets 403 — `pollApproval` falls back to the publish-requests route above):
//     GET  /api/:company/automation-approvals/:id
//   control plane (webdesk-control.controller.ts — BUILT): POST /api/:company/modules/webdev/control/sites/:siteId/keys
//     files a key.mint approval (`parseKeyRequest`); the approver's decide response carries the key ONCE (`parseKeyMintDecision`).
//   STILL PROPOSED — NOT served (WSK-60 owns them); a 404 here is `not_enabled/not_served`, never drift:
//     GET  …/sites/:tenantSlug/:siteId/build-status
//     POST …/sites/:tenantSlug/:siteId/rebuild-requests
//
//   WSK-44b re-verified every parser below against the REAL controller (platform-nest
//   `webdesk-content-ui-contract.test.ts` pipes each real response through these functions); the four drifts
//   it found are fixed here: `cancelled` approvals, nullable `headCreatedAt`, nullable `environments.domain`,
//   and a 404 `version-not-found` (it is a not-found, not "not served").
//
// ── THE CONTRACT THIS FILE ENFORCES ──────────────────────────────────────────────────────────────
// This estate's recurring bug is "frontend-first drift": a console reads a field the backend never
// sends, renders a confident wrong answer, and nothing throws. Three rules, each one a defence:
//
//  1. EVERY read in the Website workspace goes through this module (writes through
//     `webdeskContentActions.ts`, which uses the same `wdCall`). No component, page or action calls
//     `platformFetch` for WebDesk content directly, so there is one file to diff against WSK-59's
//     real responses.
//  2. EVERY 2xx body is validated against the spec'd shape BEFORE it is returned. A body that does
//     not match becomes `{ kind: "unavailable", code: "contract_drift", reason: "<path>: expected …" }`
//     — loud, named, and never rendered as data. There are no `as T` casts on a response here.
//  3. NO PATH TURNS A REFUSAL INTO `[]`. Results are the discriminated `WdResult<T>`
//     (`ok | unavailable | forbidden | not_enabled | not_found | conflict | invalid`). `ok` with an
//     empty list is EVIDENCE of emptiness; anything else is a refusal the page must render as one.
//     `readResult.ts`'s `absentAsEmpty` is deliberately not used anywhere in this workspace.
//
// ── ERRORS (§3.4) ────────────────────────────────────────────────────────────────────────────────
// WSK-59 passes Zone B's RFC 9457 problems through ("typed 409/422 pass through untouched"), so the
// body is `{ type: "https://webdesk.gaiada.online/errors/<slug>", title, status, detail?, … }` with
// the extension members (`currentHeadVersion`, `issues`) at the top level. `PlatformError.body` (an
// additive field, same rule as `reason`/`existing`) carries it here. If the BFF instead routes the
// problem through `HttpErrorFilter`'s `{ error, reason?, existing? }` reshape, `problemOf` reads the
// slug from `reason`/`error` and the extension members from `existing` — the single most likely place
// for the real BFF to differ from this file; it is isolated in `problemOf` on purpose.
import { platformFetch, PlatformError } from "./platform";
import { listMembers } from "./entities";
import {
  PRIMITIVE_NAMES,
  type ApprovalStatus, type BuildStatus, type CollectionComposition, type CollectionSummary,
  type EnvironmentRef, type ExecState, type FieldDef, type GroupMember, type Issue, type ItemAllowed, type ItemDetail, type ItemEditorial,
  type KeyMintOutcome, type KeyRequestFiled, type KeyScope, type PreviewLink,
  type ItemListBody, type ItemRef, type ItemSummary, type ItemWriteResult, type Lint, type ContentLint, type ContentFinding, type AeoScore, type AeoFactor, type ContentCheckUnavailable, type Page,
  type PrimitiveName, type PublishRequestRow, type SiteRef, type SitesBody, type TenantRef, type UnavailableCode,
  type VersionContent, type VersionFull, type VersionListBody, type WdResult,
  type WebdeskApprovalRow, type Block, hasNeutralDescendant, splitVersionContent,
} from "./webdeskContentModel";

// ── Wire validation (hand-rolled: platform-ui carries four runtime deps and a schema library is not
// going to be the fifth — see CLAUDE.md "Stack + hard constraints") ────────────────────────────────

export class WireDrift extends Error {
  constructor(public path: string, public expected: string, public got: unknown) {
    super(`${path || "<root>"}: expected ${expected}, got ${describeGot(got)}`);
  }
}

function describeGot(v: unknown): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

type P<T> = (v: unknown, path: string) => T;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const wire = {
  str: ((v, path) => { if (typeof v !== "string") throw new WireDrift(path, "string", v); return v; }) as P<string>,
  num: ((v, path) => { if (typeof v !== "number" || !Number.isFinite(v)) throw new WireDrift(path, "number", v); return v; }) as P<number>,
  int: ((v, path) => { if (typeof v !== "number" || !Number.isInteger(v)) throw new WireDrift(path, "integer", v); return v; }) as P<number>,
  bool: ((v, path) => { if (typeof v !== "boolean") throw new WireDrift(path, "boolean", v); return v; }) as P<boolean>,
  nullable: <T>(p: P<T>): P<T | null> => (v, path) => (v === null ? null : p(v, path)),
  arr: <T>(p: P<T>): P<T[]> => (v, path) => {
    if (!Array.isArray(v)) throw new WireDrift(path, "array", v);
    return v.map((x, i) => p(x, `${path}[${i}]`));
  },
  obj: ((v, path) => { if (!isRec(v)) throw new WireDrift(path, "object", v); return v; }) as P<Record<string, unknown>>,
  /** Required key on an object, parsed. A missing key is drift — never `undefined`. */
  key: <T>(o: Record<string, unknown>, k: string, p: P<T>, path: string): T => {
    if (!(k in o)) throw new WireDrift(`${path}.${k}`, "present", undefined);
    return p(o[k], `${path}.${k}`);
  },
  /** Optional key: absent => undefined; present => parsed. */
  opt: <T>(o: Record<string, unknown>, k: string, p: P<T>, path: string): T | undefined => {
    if (!(k in o) || o[k] === undefined) return undefined;
    return p(o[k], `${path}.${k}`);
  },
  record: <T>(p: P<T>): P<Record<string, T>> => (v, path) => {
    if (!isRec(v)) throw new WireDrift(path, "object", v);
    const out: Record<string, T> = {};
    for (const [k, x] of Object.entries(v)) out[k] = p(x, `${path}.${k}`);
    return out;
  },
};

const { str, int, bool, nullable, arr, obj, key, opt } = wire;
const strN = nullable(str);

function parseFieldDef(v: unknown, path: string, depth = 0): FieldDef {
  const o = obj(v, path);
  if (depth > 4) throw new WireDrift(path, "group nesting <= 4", v);
  const name = key(o, "name", str, path);
  const primitive = key(o, "primitive", str, path);
  if (!(PRIMITIVE_NAMES as readonly string[]).includes(primitive)) {
    throw new WireDrift(`${path}.primitive`, `one of ${PRIMITIVE_NAMES.join("|")}`, primitive);
  }
  const def: FieldDef = { name, primitive: primitive as PrimitiveName };
  const required = opt(o, "required", bool, path); if (required !== undefined) def.required = required;
  const options = opt(o, "options", arr(str), path); if (options !== undefined) def.options = options;
  const relationTo = opt(o, "relationTo", str, path); if (relationTo !== undefined) def.relationTo = relationTo;
  const multiple = opt(o, "multiple", bool, path); if (multiple !== undefined) def.multiple = multiple;
  const itemKey = opt(o, "itemKey", str, path); if (itemKey !== undefined) def.itemKey = itemKey;
  const localized = opt(o, "localized", bool, path); if (localized !== undefined) def.localized = localized;
  if ("fields" in o && o.fields !== undefined) def.fields = arr((x, p) => parseFieldDef(x, p, depth + 1))(o.fields, `${path}.fields`);
  if (def.primitive === "group" && (!def.fields || def.fields.length === 0)) {
    throw new WireDrift(`${path}.fields`, "non-empty (a group declares its sub-fields)", o.fields);
  }
  if ("ui" in o && o.ui !== undefined) {
    const u = obj(o.ui, `${path}.ui`);
    def.ui = {};
    const label = opt(u, "label", str, `${path}.ui`); if (label !== undefined) def.ui.label = label;
    const help = opt(u, "help", str, `${path}.ui`); if (help !== undefined) def.ui.help = help;
    const ro = opt(u, "readOnly", bool, `${path}.ui`); if (ro !== undefined) def.ui.readOnly = ro;
    const widget = opt(u, "widget", str, `${path}.ui`);
    if (widget !== undefined) {
      if (widget !== "input" && widget !== "textarea" && widget !== "code") throw new WireDrift(`${path}.ui.widget`, "input|textarea|code", widget);
      def.ui.widget = widget;
    }
  }
  return def;
}

export function parseComposition(v: unknown, path = "composition"): CollectionComposition {
  const o = obj(v, path);
  const out: CollectionComposition = {};
  if ("fields" in o && o.fields !== undefined) out.fields = arr((x, p) => parseFieldDef(x, p))(o.fields, `${path}.fields`);
  const blocks = opt(o, "blocks", arr(str), path); if (blocks !== undefined) out.blocks = blocks;
  const singleton = opt(o, "singleton", bool, path); if (singleton !== undefined) out.singleton = singleton;
  const localized = opt(o, "localized", bool, path); if (localized !== undefined) out.localized = localized;
  if ("ui" in o && o.ui !== undefined) {
    const u = obj(o.ui, `${path}.ui`);
    const ui: NonNullable<CollectionComposition["ui"]> = { label: key(u, "label", str, `${path}.ui`) };
    const description = opt(u, "description", str, `${path}.ui`); if (description !== undefined) ui.description = description;
    const group = opt(u, "group", str, `${path}.ui`); if (group !== undefined) ui.group = group;
    const order = opt(u, "order", wire.num, `${path}.ui`); if (order !== undefined) ui.order = order;
    const titleField = opt(u, "titleField", str, `${path}.ui`); if (titleField !== undefined) ui.titleField = titleField;
    out.ui = ui;
  }
  if ("lint" in o && o.lint !== undefined) out.lint = obj(o.lint, `${path}.lint`) as CollectionComposition["lint"];
  return out;
}

function parseEnvironment(v: unknown, path: string): EnvironmentRef {
  const o = obj(v, path);
  return { envId: key(o, "envId", str, path), name: key(o, "name", str, path), domain: key(o, "domain", strN, path), status: key(o, "status", str, path) };
}
function parseSite(v: unknown, path: string): SiteRef {
  const o = obj(v, path);
  return {
    siteId: key(o, "siteId", str, path), name: key(o, "name", str, path), kind: key(o, "kind", str, path),
    environments: key(o, "environments", arr(parseEnvironment), path),
  };
}
function parseTenant(v: unknown, path: string): TenantRef {
  const o = obj(v, path);
  return {
    slug: key(o, "slug", str, path), status: key(o, "status", str, path),
    defaultLocale: key(o, "defaultLocale", str, path), locales: key(o, "locales", arr(str), path),
    sites: key(o, "sites", arr(parseSite), path),
  };
}
export function parseSites(v: unknown): SitesBody {
  const o = obj(v, "sites");
  return { tenants: key(o, "tenants", arr(parseTenant), "sites") };
}

function parseCollection(v: unknown, path: string): CollectionSummary {
  const o = obj(v, path);
  const counts = obj(key(o, "counts", obj, path), `${path}.counts`);
  return {
    key: key(o, "key", str, path),
    composition: key(o, "composition", (x, p) => parseComposition(x, p), path),
    vocabularyVersion: key(o, "vocabularyVersion", str, path),
    counts: {
      items: key(counts, "items", int, `${path}.counts`),
      byLocale: key(counts, "byLocale", wire.record(int), `${path}.counts`),
      live: key(counts, "live", int, `${path}.counts`),
      pendingChanges: key(counts, "pendingChanges", int, `${path}.counts`),
    },
    updatedAt: key(o, "updatedAt", str, path),
  };
}
export function parseCollections(v: unknown): CollectionSummary[] {
  const o = obj(v, "collections");
  return key(o, "collections", arr(parseCollection), "collections");
}

function parsePage(v: unknown, path: string): Page {
  const o = obj(v, path);
  return { cursor: key(o, "cursor", strN, path), hasMore: key(o, "hasMore", bool, path), limit: key(o, "limit", int, path) };
}

export function parseItemRef(v: unknown, path: string): ItemRef {
  const o = obj(v, path);
  return {
    itemId: key(o, "itemId", str, path), collectionKey: key(o, "collectionKey", str, path),
    locale: key(o, "locale", str, path), slug: key(o, "slug", str, path),
    localizationGroupId: key(o, "localizationGroupId", str, path),
    headVersion: key(o, "headVersion", int, path), publishedVersion: key(o, "publishedVersion", nullable(int), path),
    publishState: key(o, "publishState", str, path),
    publishAt: key(o, "publishAt", strN, path), unpublishAt: key(o, "unpublishAt", strN, path),
    deletedAt: key(o, "deletedAt", strN, path), updatedAt: key(o, "updatedAt", str, path),
  };
}

function parseItemSummary(v: unknown, path: string): ItemSummary {
  const o = obj(v, path);
  return {
    itemId: key(o, "itemId", str, path), slug: key(o, "slug", str, path), locale: key(o, "locale", str, path),
    localizationGroupId: key(o, "localizationGroupId", str, path), title: key(o, "title", strN, path),
    headVersion: key(o, "headVersion", int, path), publishedVersion: key(o, "publishedVersion", nullable(int), path),
    publishState: key(o, "publishState", str, path),
    publishAt: key(o, "publishAt", strN, path), unpublishAt: key(o, "unpublishAt", strN, path),
    deletedAt: key(o, "deletedAt", strN, path), updatedAt: key(o, "updatedAt", str, path),
    headCreatedAt: key(o, "headCreatedAt", strN, path), headCreatedBy: key(o, "headCreatedBy", strN, path),
    pendingChanges: key(o, "pendingChanges", bool, path),
    // The review member is OPTIONAL (a WebDesk older than M5-W2b sends none), validated when present.
    ...(o.editorial !== undefined ? { editorial: parseEditorial(o.editorial, `${path}.editorial`) } : {}),
  };
}
export function parseItemList(v: unknown): ItemListBody {
  const o = obj(v, "items");
  return { items: key(o, "items", arr(parseItemSummary), "items"), page: key(o, "page", parsePage, "items") };
}

function parseBlock(v: unknown, path: string): Block {
  const o = obj(v, path);
  const b: Block = { type: key(o, "type", str, path) };
  if ("props" in o) b.props = o.props;
  return b;
}

const finiteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** `lint.content` (M5-W3/W3b). Tolerant on purpose: it is advisory, so a malformed entry is skipped (never a
 *  contract_drift that would block the editor), unknown finding codes are kept (consumers ignore what they do not know),
 *  and an unknown severity reads as "info". Returns undefined when `content` is absent or not an object. */
export function parseContentLint(v: unknown): ContentLint | undefined {
  if (!isRec(v)) return undefined;
  const findings: ContentFinding[] = [];
  if (Array.isArray(v.findings)) {
    for (const f of v.findings) {
      if (!isRec(f) || typeof f.code !== "string" || typeof f.message !== "string") continue;
      findings.push({ code: f.code, severity: f.severity === "warn" ? "warn" : "info", path: typeof f.path === "string" ? f.path : "/", message: f.message });
    }
  }
  let aeo: AeoScore | null = null;
  if (isRec(v.aeo) && finiteNum(v.aeo.score)) {
    const factors: AeoFactor[] = [];
    if (Array.isArray(v.aeo.factors)) {
      for (const f of v.aeo.factors) {
        if (!isRec(f) || typeof f.id !== "string" || !finiteNum(f.points) || !finiteNum(f.max)) continue;
        factors.push({ id: f.id, label: typeof f.label === "string" ? f.label : f.id, points: f.points, max: f.max, detail: typeof f.detail === "string" ? f.detail : "" });
      }
    }
    aeo = { score: Math.max(0, Math.min(100, v.aeo.score)), factors };
  }
  const unavailable: ContentCheckUnavailable[] = [];
  if (Array.isArray(v.unavailable)) {
    for (const u of v.unavailable) {
      if (isRec(u) && typeof u.rule === "string") unavailable.push({ rule: u.rule, reason: typeof u.reason === "string" ? u.reason : "" });
    }
  }
  return { findings, aeo, unavailable };
}

export function parseLint(v: unknown, path: string): Lint {
  const o = obj(v, path);
  // `unavailable` (a reason string) means the lint could not RUN. Kept only when present, so every existing result is
  // byte-identical. A non-string truthy value still means "could not run" — it must not be read as a clean lint.
  const flag = "unavailable" in o && o.unavailable !== undefined && o.unavailable !== null && o.unavailable !== false;
  const unavailable = flag ? (typeof o.unavailable === "string" && o.unavailable !== "" ? o.unavailable : "lint_unavailable") : undefined;
  const content = parseContentLint(o.content);
  const withFlag = (l: Lint): Lint => {
    const r = unavailable === undefined ? l : { ...l, unavailable };
    return content === undefined ? r : { ...r, content };
  };
  if (!("placeholders" in o) || o.placeholders === undefined || o.placeholders === null) {
    return withFlag({ unresolvedTokens: [], markers: {} }); // the collection declares no placeholder rules
  }
  const p = obj(o.placeholders, `${path}.placeholders`);
  return withFlag({
    unresolvedTokens: key(p, "unresolvedTokens", arr(str), `${path}.placeholders`),
    markers: key(p, "markers", wire.record(int), `${path}.placeholders`),
  });
}

function parseGroupMember(v: unknown, path: string): GroupMember {
  const o = obj(v, path);
  return {
    locale: key(o, "locale", str, path), itemId: key(o, "itemId", str, path), slug: key(o, "slug", str, path),
    headVersion: key(o, "headVersion", int, path), publishedVersion: key(o, "publishedVersion", nullable(int), path),
    publishState: key(o, "publishState", str, path),
  };
}

function parseVersionContent(v: unknown, path: string): VersionContent {
  const o = obj(v, path);
  return {
    n: key(o, "n", int, path), contentHash: key(o, "contentHash", str, path), createdAt: key(o, "createdAt", str, path),
    createdBy: key(o, "createdBy", strN, path), note: key(o, "note", strN, path),
    blocks: key(o, "blocks", arr(parseBlock), path),
    seo: key(o, "seo", obj, path),
  };
}

/** M5-W2b's `editorial` member: OPTIONAL (absent from a WebDesk older than M5-W2b), validated when present. */
export function parseEditorial(v: unknown, path: string): ItemEditorial {
  const o = obj(v, path);
  const out: ItemEditorial = {
    reviewRequired: key(o, "reviewRequired", bool, path),
    state: key(o, "state", str, path),
    approvedVersion: key(o, "approvedVersion", nullable(int), path),
  };
  // M5-W2e: the other members of WebDesk's view, each validated when present and left `undefined` when absent.
  const seoReq = opt(o, "seoSignoffRequired", bool, path); if (seoReq !== undefined) out.seoSignoffRequired = seoReq;
  const authorSub = opt(o, "authorSub", strN, path); if (authorSub !== undefined) out.authorSub = authorSub;
  const submitted = opt(o, "submittedVersion", nullable(int), path); if (submitted !== undefined) out.submittedVersion = submitted;
  const seoVer = opt(o, "seoSignedVersion", nullable(int), path); if (seoVer !== undefined) out.seoSignedVersion = seoVer;
  const seoBy = opt(o, "seoSignedBy", strN, path); if (seoBy !== undefined) out.seoSignedBy = seoBy;
  const seoCur = opt(o, "seoSignedCurrent", bool, path); if (seoCur !== undefined) out.seoSignedCurrent = seoCur;
  const apprBy = opt(o, "approvedBy", strN, path); if (apprBy !== undefined) out.approvedBy = apprBy;
  const apprAt = opt(o, "approvedAt", strN, path); if (apprAt !== undefined) out.approvedAt = apprAt;
  const apprHead = opt(o, "approvedIsHead", bool, path); if (apprHead !== undefined) out.approvedIsHead = apprHead;
  const due = opt(o, "dueAt", strN, path); if (due !== undefined) out.dueAt = due;
  const planned = opt(o, "plannedPublishAt", strN, path); if (planned !== undefined) out.plannedPublishAt = planned;
  const brief = opt(o, "briefRef", strN, path); if (brief !== undefined) out.briefRef = brief;
  const open = opt(o, "openComments", int, path); if (open !== undefined) out.openComments = open;
  return out;
}

/** M5-W1c's `allowed` member: OPTIONAL, validated when present (an object of booleans; anything else is wire drift). */
function parseAllowed(v: unknown, path: string): ItemAllowed {
  const o = obj(v, path);
  const out: ItemAllowed = {};
  for (const k of Object.keys(o)) out[k] = key(o, k, bool, path);
  return out;
}

export function parseItemDetail(v: unknown): ItemDetail {
  const o = obj(v, "item.get");
  const editorial = opt(o, "editorial", parseEditorial, "item.get");
  const allowed = opt(o, "allowed", parseAllowed, "item.get");
  return {
    item: key(o, "item", parseItemRef, "item.get"),
    version: key(o, "version", parseVersionContent, "item.get"),
    group: key(o, "group", arr(parseGroupMember), "item.get"),
    lint: key(o, "lint", parseLint, "item.get"),
    ...(editorial ? { editorial } : {}),
    ...(allowed ? { allowed } : {}),
  };
}

function parseVersionRow(v: unknown, path: string) {
  const o = obj(v, path);
  return {
    version: key(o, "version", int, path), contentHash: key(o, "contentHash", str, path),
    createdAt: key(o, "createdAt", str, path), createdBy: key(o, "createdBy", strN, path), note: key(o, "note", strN, path),
  };
}
export function parseVersionList(v: unknown): VersionListBody {
  const o = obj(v, "versions");
  return { versions: key(o, "versions", arr(parseVersionRow), "versions"), page: key(o, "page", parsePage, "versions") };
}
export function parseVersionFull(v: unknown): VersionFull {
  const o = obj(v, "version");
  return { ...parseVersionRow(o, "version"), blocks: key(o, "blocks", arr(parseBlock), "version"), seo: key(o, "seo", obj, "version") };
}

export function parseItemWriteResult(v: unknown): ItemWriteResult {
  const o = obj(v, "write");
  const ver = key(o, "version", obj, "write");
  return {
    item: key(o, "item", parseItemRef, "write"),
    version: { version: key(ver, "version", int, "write.version"), contentHash: key(ver, "contentHash", str, "write.version"), createdAt: key(ver, "createdAt", str, "write.version") },
    unchanged: key(o, "unchanged", bool, "write"),
    lint: key(o, "lint", parseLint, "write"),
    replayed: key(o, "replayed", bool, "write"),
  };
}
export function parseItemOnly(v: unknown): { item: ItemRef } {
  const o = obj(v, "write");
  return { item: key(o, "item", parseItemRef, "write") };
}
export function parseApprovalId(v: unknown): { approvalId: string } {
  const o = obj(v, "request");
  return { approvalId: key(o, "approvalId", str, "request") };
}
export function parseWithdraw(v: unknown): { approvalId: string; status: string } {
  const o = obj(v, "withdraw");
  return { approvalId: key(o, "approvalId", str, "withdraw"), status: key(o, "status", str, "withdraw") };
}

/** `POST …/control/sites/:siteId/keys` -> 202. STRICT, unlike the neighbouring parsers: this answers "was a key requested", and the
 *  two copies the UI shows ("Request filed" / "Already requested") hang on `alreadyPending`, so a body that carries anything else
 *  (or a flag that is not exactly `true`) is drift, never a quiet "filed". The route omits `alreadyPending` on a new filing. */
export function parseKeyRequest(v: unknown): KeyRequestFiled {
  const o = obj(v, "key-request");
  for (const k of Object.keys(o)) {
    if (k !== "approvalId" && k !== "alreadyPending") throw new WireDrift(`key-request.${k}`, "approvalId|alreadyPending", o[k]);
  }
  const approvalId = key(o, "approvalId", str, "key-request");
  if ("alreadyPending" in o && o.alreadyPending !== true) throw new WireDrift("key-request.alreadyPending", "true or absent", o.alreadyPending);
  return { approvalId, alreadyPending: o.alreadyPending === true };
}

/** `POST …/items/:itemId/preview` -> 200 `{previewUrl, expiresAt, version}`. STRICT, because the answer is OPENED IN A NEW TAB: the URL must be
 *  https, point at the site's `/preview/` page, carry the token in the FRAGMENT (`#t=…`) and no query string. Anything else is drift and
 *  nothing is opened. A `WireDrift` names the path and the TYPE it got, never the value, so the token cannot reach an error or a log. */
export function parsePreviewLink(v: unknown): PreviewLink {
  const o = obj(v, "preview");
  for (const k of Object.keys(o)) {
    if (k !== "previewUrl" && k !== "expiresAt" && k !== "version") throw new WireDrift(`preview.${k}`, "previewUrl|expiresAt|version", o[k]);
  }
  const previewUrl = key(o, "previewUrl", str, "preview");
  const expiresAt = key(o, "expiresAt", str, "preview");
  const version = key(o, "version", int, "preview");
  if (Number.isNaN(Date.parse(expiresAt))) throw new WireDrift("preview.expiresAt", "an ISO timestamp", 0);
  let u: URL | null = null;
  try { u = new URL(previewUrl); } catch { u = null; }
  if (!u || u.protocol !== "https:" || u.username !== "" || u.password !== "" || !u.pathname.endsWith("/preview/") || u.search !== "" || !u.hash.startsWith("#t=") || u.hash.length <= 3) {
    throw new WireDrift("preview.previewUrl", "an https URL to the site's /preview/ page with the token in the #t= fragment", "malformed");
  }
  return { previewUrl, expiresAt, version };
}

/** The decide façade's body for a key.mint row: `{ ok: true, webdesk?: {command, executionStatus, apiKeyId, envId, scope, plaintextOnce, error?} }`.
 *  `null` = nothing in-band to report (a rejection carries no `webdesk`). A `WireDrift` thrown here names the PATH and the TYPE it
 *  got, never the value (`describeGot`), so a malformed `plaintextOnce` cannot leak into an error message or a log. */
export function parseKeyMintDecision(v: unknown): KeyMintOutcome | null {
  const o = obj(v, "decide");
  if (!("webdesk" in o) || o.webdesk === undefined || o.webdesk === null) return null;
  const w = obj(o.webdesk, "decide.webdesk");
  const command = key(w, "command", str, "decide.webdesk");
  if (command !== "key.mint") throw new WireDrift("decide.webdesk.command", "key.mint", command);
  const status = key(w, "executionStatus", str, "decide.webdesk");
  const scopeOf = (x: unknown, path: string): KeyScope => {
    const s = str(x, path);
    if (s !== "read" && s !== "write") throw new WireDrift(path, "read|write", s);
    return s;
  };
  if (status === "executed") {
    return {
      status: "executed",
      envId: key(w, "envId", str, "decide.webdesk"),
      scope: key(w, "scope", scopeOf, "decide.webdesk"),
      apiKeyId: opt(w, "apiKeyId", strN, "decide.webdesk") ?? null,
      plaintextOnce: key(w, "plaintextOnce", strN, "decide.webdesk"),
    };
  }
  if (status === "failed") {
    return {
      status: "failed",
      envId: opt(w, "envId", str, "decide.webdesk") ?? null,
      scope: opt(w, "scope", scopeOf, "decide.webdesk") ?? null,
      error: key(w, "error", str, "decide.webdesk"),
    };
  }
  throw new WireDrift("decide.webdesk.executionStatus", "executed|failed", status);
}

export function parseBuildStatus(v: unknown): BuildStatus {
  const o = obj(v, "build-status");
  const b = o.build;
  let build: BuildStatus["build"] = null;
  if (b !== null) {
    const bo = obj(b, "build-status.build");
    const state = key(bo, "state", str, "build-status.build");
    if (state !== "rebuilding" && state !== "live" && state !== "unverified" && state !== "failed") {
      throw new WireDrift("build-status.build.state", "rebuilding|live|unverified|failed", state);
    }
    const kind = key(bo, "kind", str, "build-status.build");
    if (kind !== "publish" && kind !== "rebuild") throw new WireDrift("build-status.build.kind", "publish|rebuild", kind);
    build = {
      approvalId: key(bo, "approvalId", strN, "build-status.build"), kind,
      requestedAt: key(bo, "requestedAt", str, "build-status.build"), publishedAt: key(bo, "publishedAt", strN, "build-status.build"),
      state, stagingUrl: key(bo, "stagingUrl", strN, "build-status.build"), verifiedAt: key(bo, "verifiedAt", strN, "build-status.build"),
    };
  } else if (!("build" in o)) {
    throw new WireDrift("build-status.build", "present", undefined);
  }
  return { build, stagingStale: key(o, "stagingStale", bool, "build-status") };
}

const APPROVAL_STATUSES: readonly string[] = ["pending", "approved", "rejected", "cancelled"];
const EXEC_STATES: readonly string[] = ["not_applicable", "pending", "executing", "executed", "failed"];

/** `GET /api/:t/automation-approvals/:id` — camelCase detail (APPR-01). Only what the UI reads. */
export function parseApprovalRow(v: unknown): WebdeskApprovalRow {
  const o = obj(v, "approval");
  const status = key(o, "status", str, "approval");
  if (!APPROVAL_STATUSES.includes(status)) throw new WireDrift("approval.status", APPROVAL_STATUSES.join("|"), status);
  // `executionStatus` is optional-by-history (older rows omit it): absent stays `null` = UNKNOWN,
  // never coerced to `not_applicable` (`lib/automationApprovals.ts` documents the same rule).
  let executionStatus: ExecState | null = null;
  if ("executionStatus" in o && o.executionStatus !== null && o.executionStatus !== undefined) {
    const es = str(o.executionStatus, "approval.executionStatus");
    if (!EXEC_STATES.includes(es)) throw new WireDrift("approval.executionStatus", EXEC_STATES.join("|"), es);
    executionStatus = es as ExecState;
  }
  const optStr = (k: string): string | null => (k in o && o[k] !== null && o[k] !== undefined ? str(o[k], `approval.${k}`) : null);
  return {
    id: key(o, "id", str, "approval"), workflowId: key(o, "workflowId", str, "approval"),
    status: status as ApprovalStatus, executionStatus, executionError: optStr("executionError"),
    requestedBy: optStr("requestedBy"), requestedByName: optStr("requestedByName"),
    decidedBy: optStr("decidedBy"), decidedByName: optStr("decidedByName"), decidedAt: optStr("decidedAt"),
    createdAt: key(o, "createdAt", str, "approval"), reason: optStr("reason"),
    toolArgs: o.toolArgs,
  };
}

// ── Problems / errors → results ──────────────────────────────────────────────────────────────────

const PROBLEM_BASE_MARK = "/errors/";

export interface Problem { slug: string | null; message: string; ext: Record<string, unknown> }

/** The ONE place the BFF's error body shape is interpreted (see the header). */
export function problemOf(e: PlatformError): Problem {
  const body = isRec(e.body) ? e.body : null;
  let slug: string | null = null;
  let message = e.message;
  let ext: Record<string, unknown> = {};
  if (body) {
    if (typeof body.type === "string" && body.type.includes(PROBLEM_BASE_MARK)) slug = body.type.slice(body.type.lastIndexOf("/") + 1);
    else if (typeof body.reason === "string") slug = body.reason;
    else if (typeof body.error === "string" && /^[a-z][a-z0-9_-]*$/.test(body.error)) slug = body.error;
    if (typeof body.detail === "string") message = body.detail;
    else if (typeof body.title === "string") message = body.title;
    else if (typeof body.error === "string") message = body.error;
    ext = { ...body, ...(isRec(body.existing) ? body.existing : {}) };
  } else if (e.reason) slug = e.reason;
  return { slug, message, ext };
}

function parseIssues(ext: Record<string, unknown>): Issue[] | null {
  if (!Array.isArray(ext.issues)) return null;
  const out: Issue[] = [];
  for (const i of ext.issues) {
    if (!isRec(i) || typeof i.path !== "string" || typeof i.message !== "string") return null;
    out.push({ path: i.path, message: i.message, ...(typeof i.expected === "string" ? { expected: i.expected } : {}) });
  }
  return out;
}

// `approval_not_found` is the withdraw route's 404 (an id that is not a publish request for THIS site): a real answer, not "not served".
// `environment-not-found` is the key-request route's 404 for an environment that is not on THIS site: a real answer, and no existing
// route emits it, so adding it changes no existing case. `comment-not-found` (M5-W2e) is the editorial resolve route's 404 for a comment
// that is not on this item: without it the 404 read as "not served on this deployment".
const NOT_FOUND_SLUGS = new Set(["item-not-found", "collection-not-found", "site-not-found", "version-not-found", "approval_not_found", "environment-not-found", "comment-not-found"]);

export function resultFromError(e: unknown): WdResult<never> {
  if (e instanceof WireDrift) return { kind: "unavailable", code: "contract_drift", reason: e.message };
  if (!(e instanceof PlatformError)) {
    return { kind: "unavailable", code: "network", reason: (e as Error)?.message ?? "unknown error" };
  }
  const p = problemOf(e);
  const s = e.status;
  // Editorial-assertion refusals are a CONFIGURATION fault (keys, clock, replay), not "you may not".
  const editorialFault = p.slug?.startsWith("editorial-assertion") ?? false;
  if (s === 503) {
    const code: UnavailableCode = "editorial_unavailable";
    return { kind: "unavailable", code, reason: p.slug ?? p.message };
  }
  if (editorialFault) return { kind: "unavailable", code: "upstream_error", reason: p.slug ?? p.message };
  if (s === 401) return { kind: "unavailable", code: "upstream_error", reason: "session_expired" };
  if (s === 403) return { kind: "forbidden", reason: p.message };
  if (s === 404) {
    if (p.slug && NOT_FOUND_SLUGS.has(p.slug)) return { kind: "not_found", slug: p.slug };
    if (/module\s+\S+\s+not enabled/i.test(p.message)) return { kind: "not_enabled", reason: "module_disabled" };
    return { kind: "not_enabled", reason: "not_served" };
  }
  if (s === 409) {
    const head = typeof p.ext.currentHeadVersion === "number" ? p.ext.currentHeadVersion : null;
    return {
      kind: "conflict", slug: p.slug ?? "conflict", message: p.message, currentHeadVersion: head,
      currentContentHash: typeof p.ext.currentContentHash === "string" ? p.ext.currentContentHash : null,
      updatedAt: typeof p.ext.updatedAt === "string" ? p.ext.updatedAt : null,
    };
  }
  if (s === 422 || s === 400 || s === 413) {
    const issues = parseIssues(p.ext);
    return {
      kind: "invalid",
      issues: issues ?? [{ path: e.field ? `/blocks/0/props/${e.field}` : "", message: p.message }],
      message: s === 413 ? "That content is too large to save." : p.message,
    };
  }
  return { kind: "unavailable", code: "upstream_error", reason: p.slug ?? p.message };
}

/** One BFF call: egress, validate, and fold every failure into a `WdResult`. */
export async function wdCall<T>(path: string, userId: string, parse: (raw: unknown) => T, init: RequestInit = {}): Promise<WdResult<T>> {
  let raw: unknown;
  try {
    raw = await platformFetch<unknown>(path, userId, init);
  } catch (e) {
    return resultFromError(e);
  }
  try {
    return { kind: "ok", data: parse(raw) };
  } catch (e) {
    return resultFromError(e);
  }
}

// ── Paths ────────────────────────────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;
export const contentBase = (company: string) => `/api/${enc(company)}/modules/webdev/content`;
export const siteBase = (company: string, tenantSlug: string, siteId: string) =>
  `${contentBase(company)}/sites/${enc(tenantSlug)}/${enc(siteId)}`;
/** The control plane's site route (`webdesk-control.controller.ts`): keyed by `siteId` ALONE, with `tenantSlug` in the body. */
export const controlSiteBase = (company: string, siteId: string) =>
  `/api/${enc(company)}/modules/webdev/control/sites/${enc(siteId)}`;

// ── Readers ──────────────────────────────────────────────────────────────────────────────────────

export function listSites(userId: string, company: string) {
  return wdCall(`${contentBase(company)}/sites`, userId, parseSites);
}

export function listCollections(userId: string, company: string, tenantSlug: string, siteId: string) {
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/collections`, userId, parseCollections);
}

export interface ItemListQuery {
  locale?: string; state?: string; q?: string; cursor?: string; limit?: number;
}

export function listItems(userId: string, company: string, tenantSlug: string, siteId: string, collectionKey: string, q: ItemListQuery = {}) {
  const p = new URLSearchParams();
  if (q.locale) p.set("locale", q.locale);
  if (q.state) p.set("state", q.state);
  if (q.q) p.set("q", q.q);
  if (q.cursor) p.set("cursor", q.cursor);
  p.set("limit", String(Math.min(q.limit ?? 100, 100)));
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/collections/${enc(collectionKey)}/items?${p.toString()}`, userId, parseItemList);
}

export function getItem(userId: string, company: string, tenantSlug: string, siteId: string, itemId: string, version?: "head" | "live" | number) {
  const qs = version === undefined ? "" : `?version=${version}`;
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/items/${enc(itemId)}${qs}`, userId, parseItemDetail);
}

export function listVersions(userId: string, company: string, tenantSlug: string, siteId: string, itemId: string, cursor?: string) {
  const qs = cursor ? `?cursor=${enc(cursor)}&limit=100` : "?limit=100";
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/items/${enc(itemId)}/versions${qs}`, userId, parseVersionList);
}

export function getVersion(userId: string, company: string, tenantSlug: string, siteId: string, itemId: string, n: number) {
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/items/${enc(itemId)}/versions/${n}`, userId, parseVersionFull);
}

/** PROPOSED endpoint — see the header. A 404 here is NOT "no build": it is `not_enabled/not_served`,
 *  and the caller renders "rebuild status isn't available yet", never "live". */
export function getBuildStatus(userId: string, company: string, tenantSlug: string, siteId: string) {
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/build-status`, userId, parseBuildStatus);
}

export function getApprovalRow(userId: string, company: string, approvalId: string) {
  return wdCall(`/api/${enc(company)}/automation-approvals/${enc(approvalId)}`, userId, parseApprovalRow);
}

/** `GET …/publish-requests` — the CALLER'S OWN publish/schedule approvals for one site (WSK-44b). The
 *  generic approvals list needs `automation_approval:read` (company_admin/manager), which an editor does
 *  not hold; this route is authorised as the right that filed the request. */
export function parsePublishRequests(v: unknown): PublishRequestRow[] {
  const o = obj(v, "publish-requests");
  return key(o, "requests", arr((row, path) => {
    const r = obj(row, path);
    const status = key(r, "status", str, path);
    if (!APPROVAL_STATUSES.includes(status)) throw new WireDrift(`${path}.status`, APPROVAL_STATUSES.join("|"), status);
    const es = key(r, "executionStatus", strN, path);
    if (es !== null && !EXEC_STATES.includes(es)) throw new WireDrift(`${path}.executionStatus`, EXEC_STATES.join("|"), es);
    // `items` is optional on the wire: a BFF one release behind omits it, so absent => [] (no version known).
    const items = opt(r, "items", arr((x, p) => {
      const it = obj(x, p);
      const version = key(it, "version", int, p);
      if (version < 1) throw new WireDrift(`${p}.version`, "positive integer", version);
      return { itemId: key(it, "itemId", str, p), version };
    }), path) ?? [];
    return {
      approvalId: key(r, "approvalId", str, path), status: status as ApprovalStatus, createdAt: key(r, "createdAt", str, path),
      itemIds: key(r, "itemIds", arr(str), path), items, executionStatus: es as ExecState | null,
    };
  }), "publish-requests");
}

export function listOwnPublishRequests(
  userId: string, company: string, tenantSlug: string, siteId: string, status: "pending" | "approved" | "rejected" | "cancelled" | "all" = "pending",
) {
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/publish-requests?status=${status}`, userId, parsePublishRequests);
}

/** The caller's pending publish requests that name `itemId` (the editor's "pending request after reload"). */
export async function findPendingPublishRequests(
  userId: string, company: string, tenantSlug: string, siteId: string, itemId: string,
): Promise<WdResult<{ approvalId: string; version: number | null }[]>> {
  const r = await listOwnPublishRequests(userId, company, tenantSlug, siteId, "pending");
  if (r.kind !== "ok") return r;
  return {
    kind: "ok",
    data: r.data.filter((q) => q.status === "pending" && q.itemIds.includes(itemId))
      .map((q) => ({ approvalId: q.approvalId, version: q.items.find((i) => i.itemId === itemId)?.version ?? null })),
  };
}

/** One approval for the editor's poll. The detail route needs `automation_approval:read`; a requester
 *  without it (webdev_staff) gets 403 there, so on `forbidden` fall back to their OWN requests for this site.
 *  The fallback row has no decider name or execution error (the route does not carry them): the phase is
 *  still right, the copy is just less specific. */
export async function pollApproval(userId: string, company: string, tenantSlug: string, siteId: string, approvalId: string): Promise<WdResult<WebdeskApprovalRow>> {
  const detail = await getApprovalRow(userId, company, approvalId);
  if (detail.kind !== "forbidden") return detail;
  const own = await listOwnPublishRequests(userId, company, tenantSlug, siteId, "all");
  if (own.kind !== "ok") return own;
  const hit = own.data.find((q) => q.approvalId === approvalId);
  if (!hit) return detail;
  return {
    kind: "ok",
    data: {
      id: hit.approvalId, workflowId: "content.publish", status: hit.status, executionStatus: hit.executionStatus, executionError: null,
      requestedBy: userId, requestedByName: null, decidedBy: null, decidedByName: null, decidedAt: null, createdAt: hit.createdAt, reason: null, toolArgs: undefined,
    },
  };
}

// ── Composite: resolve a slug to its item, page by page ──────────────────────────────────────────
// The route table is `…/[collection]/[slug]?locale=en` but WSK-59 has no read-by-slug (items are
// addressed by `itemId`). `item.list` is ordered by `slug, locale, id` and filters by locale; this
// walks it until the slug appears. Capped so a bad slug cannot loop. FOLLOW-UP for WSK-59: a
// `?slug=` filter (or by-slug get) would make this one call.
const SLUG_SCAN_MAX_PAGES = 20;

export async function resolveItemBySlug(
  userId: string, company: string, tenantSlug: string, siteId: string, collectionKey: string, slug: string, locale: string,
): Promise<WdResult<ItemSummary>> {
  let cursor: string | undefined;
  for (let i = 0; i < SLUG_SCAN_MAX_PAGES; i++) {
    const r = await listItems(userId, company, tenantSlug, siteId, collectionKey, { locale, cursor, limit: 100 });
    if (r.kind !== "ok") return r;
    const hit = r.data.items.find((it) => it.slug === slug && it.locale === locale);
    if (hit) return { kind: "ok", data: hit };
    if (!r.data.page.hasMore || !r.data.page.cursor) break;
    cursor = r.data.page.cursor;
  }
  // The default list hides deleted items. A deleted item's URL must still open (read-only, with the
  // reason), so look in the `deleted` state before concluding it does not exist.
  cursor = undefined;
  for (let i = 0; i < SLUG_SCAN_MAX_PAGES; i++) {
    const r = await listItems(userId, company, tenantSlug, siteId, collectionKey, { locale, state: "deleted", cursor, limit: 100 });
    if (r.kind !== "ok") return r;
    const hit = r.data.items.find((it) => it.slug === slug && it.locale === locale);
    if (hit) return { kind: "ok", data: hit };
    if (!r.data.page.hasMore || !r.data.page.cursor) break;
    cursor = r.data.page.cursor;
  }
  return { kind: "not_found", slug: "item-not-found" };
}

// ── Composite: everything the editor page needs, in one result ──────────────────────────────────

export interface EditorBundle {
  tenant: TenantRef;
  site: SiteRef;
  collection: CollectionSummary;
  detail: ItemDetail;
  /** The DEFAULT-locale twin's stored fields — only loaded for a non-default locale whose composition
   *  has locale-neutral members (§2.5 rule 2). `null` + `authoritativeProblem` when it could not be. */
  authoritative: { locale: string; fields: Record<string, unknown> } | null;
  authoritativeProblem: string | null;
  /** Pending publish requests that name this item. `null` + problem when the lookup failed. */
  pendingRequests: { approvalId: string; version: number | null }[] | null;
  pendingProblem: string | null;
  /** `null` until/unless the proposed build-status route answers. */
  build: BuildStatus | null;
  buildProblem: string | null;
  loadedAt: string;
}


export async function loadEditorBundle(
  userId: string, company: string, tenantSlug: string, siteId: string, collectionKey: string, slug: string, requestedLocale: string | null,
): Promise<WdResult<EditorBundle>> {
  const [sites, collections] = await Promise.all([
    listSites(userId, company),
    listCollections(userId, company, tenantSlug, siteId),
  ]);
  if (sites.kind !== "ok") return sites;
  if (collections.kind !== "ok") return collections;
  const tenant = sites.data.tenants.find((t) => t.slug === tenantSlug);
  const site = tenant?.sites.find((s) => s.siteId === siteId);
  if (!tenant || !site) return { kind: "not_found", slug: "site-not-found" };
  const collection = collections.data.find((c) => c.key === collectionKey);
  if (!collection) return { kind: "not_found", slug: "collection-not-found" };

  // No `?locale=` means the tenant default. A locale-neutral collection only exists in the default locale.
  const locale = collection.composition.localized === false ? tenant.defaultLocale : (requestedLocale ?? tenant.defaultLocale);
  const summary = await resolveItemBySlug(userId, company, tenantSlug, siteId, collectionKey, slug, locale);
  if (summary.kind !== "ok") return summary;
  const detail = await getItem(userId, company, tenantSlug, siteId, summary.data.itemId, "head");
  if (detail.kind !== "ok") return detail;

  const [authoritative, pending, build] = await Promise.all([
    (async (): Promise<{ value: EditorBundle["authoritative"]; problem: string | null }> => {
      const defs = collection.composition.fields ?? [];
      if (locale === tenant.defaultLocale || !defs.some(hasNeutralDescendant)) return { value: null, problem: null };
      const twin = detail.data.group.find((g) => g.locale === tenant.defaultLocale);
      if (!twin) return { value: null, problem: `There is no ${tenant.defaultLocale} version yet, so locale-neutral fields show this item's own copy.` };
      const r = await getItem(userId, company, tenantSlug, siteId, twin.itemId, "head");
      if (r.kind !== "ok") return { value: null, problem: `The ${tenant.defaultLocale} version could not be read (${describeFailure(r)}), so locale-neutral fields show this item's own copy.` };
      return { value: { locale: tenant.defaultLocale, fields: splitVersionContent(collectionKey, r.data.version.blocks, r.data.version.seo).fields }, problem: null };
    })(),
    findPendingPublishRequests(userId, company, tenantSlug, siteId, detail.data.item.itemId),
    getBuildStatus(userId, company, tenantSlug, siteId),
  ]);

  return {
    kind: "ok",
    data: {
      tenant, site, collection, detail: detail.data,
      authoritative: authoritative.value, authoritativeProblem: authoritative.problem,
      pendingRequests: pending.kind === "ok" ? pending.data : null,
      pendingProblem: pending.kind === "ok" ? null : describeFailure(pending),
      build: build.kind === "ok" ? build.data : null,
      buildProblem: build.kind === "ok" ? null : describeFailure(build),
      loadedAt: new Date().toISOString(),
    },
  };
}

/** One honest sentence for a non-ok result — for the secondary reads that must not take the page down. */
export function describeFailure(r: Exclude<WdResult<unknown>, { kind: "ok" }>): string {
  switch (r.kind) {
    case "unavailable": return r.code === "contract_drift" ? `unexpected response — ${r.reason}` : r.reason;
    case "forbidden": return "you do not have access";
    case "not_enabled": return r.reason === "module_disabled" ? "the module is switched off" : "not available on this deployment yet";
    case "not_found": return "not found";
    case "conflict": return r.message;
    case "invalid": return r.message;
  }
}

export function stagingBaseUrl(site: SiteRef): string | null {
  const env = site.environments.find((e) => e.name.toLowerCase() === "staging" && e.domain);
  return env && env.domain ? `https://${env.domain}` : null;
}

/** Best-effort id -> display name from the company directory, for version authors. COSMETIC: a failure
 *  yields an empty map and  falls back to a short id — the one place in this module where
 *  a failed read is deliberately not surfaced, because it decorates an author column and states nothing
 *  about content. */
export async function resolveAuthorNames(userId: string, company: string): Promise<Record<string, string>> {
  try {
    // Authors include automation principals (the importer wrote every gaiada.com v1), which `/members` leaves out
    // unless asked: without them those versions read "user 01a12709" instead of the account's name.
    const members = await listMembers(userId, company, { includeService: true });
    const out: Record<string, string> = {};
    if (Array.isArray(members)) for (const m of members) if (m && typeof m.user_id === "string" && typeof m.name === "string") out[m.user_id] = m.name;
    return out;
  } catch {
    return {};
  }
}

/** The site + its collections: what every list/history page resolves before anything else. */
export interface SiteContext { tenant: TenantRef; site: SiteRef; collections: CollectionSummary[] }

export async function loadSiteContext(userId: string, company: string, tenantSlug: string, siteId: string): Promise<WdResult<SiteContext>> {
  const [sites, collections] = await Promise.all([
    listSites(userId, company),
    listCollections(userId, company, tenantSlug, siteId),
  ]);
  if (sites.kind !== "ok") return sites;
  if (collections.kind !== "ok") return collections;
  const tenant = sites.data.tenants.find((t) => t.slug === tenantSlug);
  const site = tenant?.sites.find((s) => s.siteId === siteId);
  if (!tenant || !site) return { kind: "not_found", slug: "site-not-found" };
  return { kind: "ok", data: { tenant, site, collections: collections.data } };
}

/** Names for a key.mint approval's environment and site, from the wall's own site read. COSMETIC, like `resolveAuthorNames`: the
 *  approval's `tool_args` carry only ids, so the summary reads better with names, and a failed read yields `null` (the summary then
 *  shows the ids) rather than taking the approval page down. */
export async function findKeyTarget(
  userId: string, company: string, tenantSlug: string, siteId: string, envId: string,
): Promise<{ siteName: string; environmentName: string | null } | null> {
  const sites = await listSites(userId, company);
  if (sites.kind !== "ok") return null;
  const site = sites.data.tenants.find((t) => t.slug === tenantSlug)?.sites.find((s) => s.siteId === siteId);
  if (!site) return null;
  return { siteName: site.name, environmentName: site.environments.find((e) => e.envId.toLowerCase() === envId.toLowerCase())?.name ?? null };
}
