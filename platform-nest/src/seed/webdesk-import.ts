// WSK-67 — the gaiada.com content importer: loads WSK-54's bundle into WebDesk THROUGH THE ERP's own content
// service (WSK-59), as the importer principal. Design: docs/plans/2026-10-10-webdesk-write-plane-design.md
// §8 (the M1 loader principal) and §12 WSK-67.
//
//   node dist/seed/webdesk-import.js   --tenant-id <erpCompanyId> --site <tenantSlug>/<siteId> \
//        --bundle <path> --principal <importerUserId> [--apply] [--request-publish]
//   tsx scripts/webdesk-import.ts      (the same code, for a dev checkout)
//
// WHY THIS LIVES IN src/seed/ AND scripts/webdesk-import.ts IS A LAUNCHER. The platform image compiles ONLY
// `src/` (`tsc -p tsconfig.build.json`, rootDir src) and installs `--omit=dev`: `scripts/*.ts` is not in the
// image and `tsx` is not installed there. Every operator CLI that must run in the container is a `src/seed/*.ts`
// compiled to `dist/seed/*.js` (`seed:owner-grant`, `import:nexus`, ...). `scripts/webdesk-import.ts` keeps the
// ticket's documented entry point for a dev checkout and calls `main()` below.
//
// THE CONTRACT, in one paragraph. It is a CLIENT of `webdeskContent` (WSK-59). Nothing here talks to WebDesk
// itself: every call is Cerbos-authorised as the importer (`authorizeContent`), the writes are signed with the
// editorial assertion (WSK-40) and carried over the four-layer channel, and an ambiguous write is reconciled by
// reading (the service's own `reconcile`). The module exposes only apply-compositions, upsert-items and
// request-publish. It never publishes, unpublishes or deletes, and imports nothing that could (a static test
// reads this file's imports). One batch publish approval is FILED (WSK-D46: a batch always needs a second
// person); the owner decides it.
//
// DEFAULT IS A DRY RUN: reads only, zero writes. `--apply` writes. `--request-publish` needs `--apply`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { authorize } from "../core/http";
import { closePool, withGlobal, withTenants } from "../db";
import { assemblePrincipal, type Principal } from "../rbac/principal";
import { fileWebdeskCommandApproval } from "../modules/webdev/webdesk-approved-command";
import { wireWebdeskEditorialSigner } from "../modules/webdev/webdesk-editorial-signer";
import {
  WebdeskProblem,
  authorizeContent,
  controlApplySchema,
  problemSlug,
  resolveEditableSite,
  webdeskContent,
  type ContentGate,
  type SiteRef,
} from "../modules/webdev/webdesk-content.service";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export interface BundleItem {
  collectionKey: string;
  locale: string;
  slug: string;
  twinOfSlug?: string;
  fields: Record<string, unknown>;
  blocks?: unknown[];
  seo: Record<string, unknown>;
}

export interface Bundle {
  bundleVersion: number;
  vocabularyVersion: string;
  site: string;
  sourceCommit: string;
  compositions: Record<string, Record<string, unknown>>;
  items: BundleItem[];
  sha256: string;
}

export interface ImportOptions {
  tenantId: string;
  site: SiteRef;
  bundlePath: string;
  principalId: string;
  apply: boolean;
  requestPublish: boolean;
}

export type ItemAction = "create" | "update" | "skip" | "blocked";

export interface PlannedItem {
  item: BundleItem;
  action: ItemAction;
  /** Why it is blocked, or what the update replaces. */
  reason?: string;
  itemId?: string;
  headVersion?: number;
  /** The content hash the bundle item would have in WebDesk (see `contentHashOf`). */
  hash: string;
}

export interface ImportReport {
  dryRun: boolean;
  bundleSha256: string;
  principalId: string;
  compositions: { apply: string[]; skip: string[] };
  /** collection → locale → action → count. */
  plan: Record<string, Record<string, Record<ItemAction, number>>>;
  totals: Record<ItemAction, number>;
  /** Writes performed by this run (0 on a dry run). */
  writes: { schemaApplied: number; created: number; updated: number; unchanged: number; versionsWritten: number };
  failures: Array<{ where: string; reason: string }>;
  publishApprovalId: string | null;
  /** What a dry run says `--request-publish` would file (or why it cannot). */
  publishPreview: { items: number; counts: Record<string, number> } | { refused: string } | null;
  lines: string[];
}

export class ImporterRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImporterRefusal";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEM_RE = /^[\x21-\x7e]{8,200}$/;
const MAX_PUBLISH_ITEMS = 1000;
const READ_CONCURRENCY = 8;
const NOTE_PREFIX = "wsk67 import";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The principal (design §8; WSK-47's finding)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** The ids WEBDESK_IMPORTER_PRINCIPALS lists (comma or whitespace separated, case-insensitive). */
export function importerPrincipalAllowList(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.WEBDESK_IMPORTER_PRINCIPALS ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Resolves the importer principal, or refuses. Accepted ONLY when the user is `users.kind='automation'` AND
 * listed in WEBDESK_IMPORTER_PRINCIPALS: a human id, an unlisted id and an unknown id are all refused, so the
 * CLI cannot be used to act as a person.
 *
 * ASSURANCE. `assemblePrincipal(id, assurance)` takes the assurance as an INPUT: the AuthGuard passes the
 * tier its channel earned. An automation principal is minted at `low` on its own channels, and WSK-47's
 * Cerbos ALLOW rules all require `variables.notLow`, so a `low` importer would be denied EVERYTHING, silently
 * ("not authorized" with no hint). This CLI therefore assembles the principal with an explicit `linked`
 * (non-low): the operator running a command inside the ERP container IS the authentication. Anyone who can
 * `docker compose exec` into the platform container already holds the database and the signing key, so this
 * grants nothing they did not have. It is `linked` (standard in-tenant access), not `high`: nothing the
 * importer does needs the sensitive/bulk tier, and the publish rules still DENY it (maker != checker, and the
 * approval is the owner's).
 */
export async function resolveImporterPrincipal(userId: string, env: NodeJS.ProcessEnv = process.env): Promise<Principal> {
  if (!UUID_RE.test(userId)) throw new ImporterRefusal("--principal must be a user id (uuid)");
  const listed = importerPrincipalAllowList(env);
  if (listed.size === 0) throw new ImporterRefusal("WEBDESK_IMPORTER_PRINCIPALS is empty: no principal may run the importer");
  if (!listed.has(userId.toLowerCase())) {
    throw new ImporterRefusal(`principal ${userId} is not listed in WEBDESK_IMPORTER_PRINCIPALS`);
  }
  const row = await withGlobal((c) =>
    c.query<{ kind: string; status: string }>(`SELECT kind, status FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]),
  );
  const u = row.rows[0];
  if (!u) throw new ImporterRefusal(`principal ${userId} is not a user`);
  if (u.kind !== "automation") {
    throw new ImporterRefusal(`principal ${userId} is a '${u.kind}' user: the importer runs only as a users.kind='automation' principal`);
  }
  const base = await assemblePrincipal(userId, "linked");
  if (!base) throw new ImporterRefusal(`principal ${userId} is not active`);
  // `via.provider === 'n8n'` is the ONE existing channel WSK-59's signer maps to `pk:'automation'` (design §5:
  // attribution only, never authorisation). Without it the importer would be signed as `pk:'human'`.
  return { ...base, via: { provider: "n8n", externalId: "webdesk-import" } };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The bundle
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** Same canonical form as WebDesk's `ws4-assertion.ts` / the site exporter's `canonical.mjs`: sorted keys. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`)
    .join(",")}}`;
}

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Loads and VERIFIES a bundle: shape, version, no duplicate identities, and its own sha256 (so a hand-edited
 *  or truncated file is refused before anything is read from WebDesk). */
export function loadBundle(path: string): Bundle {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ImporterRefusal(`cannot read bundle ${path}: ${(err as Error).message}`);
  }
  if (!isObj(raw)) throw new ImporterRefusal("bundle must be a JSON object");
  if (raw.bundleVersion !== 1) throw new ImporterRefusal(`unsupported bundleVersion ${String(raw.bundleVersion)} (this importer reads 1)`);
  if (typeof raw.site !== "string" || typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
    throw new ImporterRefusal("bundle has no site / sha256");
  }
  if (!isObj(raw.compositions) || !Array.isArray(raw.items)) throw new ImporterRefusal("bundle needs `compositions` and `items`");
  const { sha256, ...rest } = raw;
  if (sha256Hex(canonicalize(rest)) !== sha256) throw new ImporterRefusal("bundle sha256 does not match its content (the file was edited or damaged)");
  const seen = new Set<string>();
  for (const [i, it] of (raw.items as unknown[]).entries()) {
    if (!isObj(it) || typeof it.collectionKey !== "string" || typeof it.locale !== "string" || typeof it.slug !== "string" || !isObj(it.fields) || !isObj(it.seo)) {
      throw new ImporterRefusal(`items[${i}] is not { collectionKey, locale, slug, fields, seo }`);
    }
    if (!isObj((raw.compositions as Record<string, unknown>)[it.collectionKey])) {
      throw new ImporterRefusal(`items[${i}] is in collection "${it.collectionKey}", which has no composition in the bundle`);
    }
    const id = identity(it as unknown as BundleItem);
    if (seen.has(id)) throw new ImporterRefusal(`items[${i}] duplicates ${it.collectionKey}/${it.locale}/${it.slug}`);
    seen.add(id);
  }
  return raw as unknown as Bundle;
}

const identity = (i: Pick<BundleItem, "collectionKey" | "locale" | "slug">): string => `${i.collectionKey}\u0000${i.locale}\u0000${i.slug}`;

/** Twin sources first: a twin's `twinOf` needs the other locale's item id, so `en` precedes `id`. */
function orderedItems(bundle: Bundle): BundleItem[] {
  const rank = (l: string) => (l === "en" ? 0 : 1);
  return [...bundle.items].sort(
    (a, b) => (a.collectionKey < b.collectionKey ? -1 : a.collectionKey > b.collectionKey ? 1 : 0) || rank(a.locale) - rank(b.locale) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
}

/**
 * The `{blocks, seo}` WebDesk stores for a bundle item, mirroring WSK-41's `assembleItemContent`
 * (webdesk/api/src/control/content/content-projection.ts): a collection whose composition declares `fields`
 * stores `blocks[0] = {type:'fields', props: fields}` followed by the item's blocks; one that declares none
 * stores the blocks alone; the `redirect` system collection stores its values under `seo.redirect` with no
 * blocks. A test pins this against WebDesk's own function on the real bundle.
 */
export function assembledContent(item: BundleItem, composition: Record<string, unknown>): { blocks: unknown[]; seo: Record<string, unknown> } {
  if (item.collectionKey === "redirect") return { blocks: [], seo: { ...item.seo, redirect: item.fields } };
  const tail = item.blocks ?? [];
  const declaresFields = Array.isArray(composition.fields);
  return { blocks: declaresFields ? [{ type: "fields", props: item.fields }, ...tail] : [...tail], seo: item.seo };
}

/** WebDesk's `contentHash`: sha256 of the canonical `{blocks, seo}`. */
export function contentHashOf(blocks: unknown, seo: unknown): string {
  return sha256Hex(canonicalize({ blocks, seo }));
}

/** The idempotency key of the spec: `import:<bundleSha256>:<collection>:<locale>:<slug>`. A slug that would make
 *  it an illegal header value (the redirect collection's slugs are paths; any may be non-ASCII or long) is
 *  replaced by its sha256, so the key stays a pure function of the same four inputs. */
export function idempotencyKeyFor(bundleSha: string, item: Pick<BundleItem, "collectionKey" | "locale" | "slug">, suffix = ""): string {
  const direct = `import:${bundleSha}:${item.collectionKey}:${item.locale}:${item.slug}${suffix}`;
  if (IDEM_RE.test(direct)) return direct;
  return `import:${bundleSha}:${item.collectionKey}:${item.locale}:~${sha256Hex(item.slug)}${suffix}`;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Reading WebDesk (through the service; read gates)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

interface Existing {
  itemId: string;
  headVersion: number;
  deletedAt: string | null;
  /** The head version's content hash, computed from the head's blocks and seo when WebDesk returned them. */
  hash: string | null;
}

interface Gates {
  collRead: ContentGate;
  itemRead: ContentGate;
}

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function readCollections(g: Gates, site: SiteRef): Promise<Map<string, Record<string, unknown>>> {
  const r = await webdeskContent.listCollections(g.collRead, site);
  const list = isObj(r.body) && Array.isArray(r.body.collections) ? r.body.collections : [];
  const out = new Map<string, Record<string, unknown>>();
  for (const c of list) if (isObj(c) && typeof c.key === "string") out.set(c.key, isObj(c.composition) ? c.composition : {});
  return out;
}

/** Every item of `collection`/`locale` WebDesk holds (deleted ones included: a deleted slug still blocks a create). */
async function readExisting(g: Gates, site: SiteRef, collection: string, locale: string): Promise<Map<string, Existing>> {
  const out = new Map<string, Existing>();
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const r = await webdeskContent.listItems(g.itemRead, site, collection, {
      locale,
      includeDeleted: "true",
      limit: "100",
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const body = r.body as { items?: unknown[]; page?: { cursor: string | null; hasMore: boolean } };
    for (const it of body.items ?? []) {
      if (!isObj(it) || typeof it.slug !== "string" || typeof it.itemId !== "string" || typeof it.headVersion !== "number") continue;
      out.set(it.slug, { itemId: it.itemId, headVersion: it.headVersion, deletedAt: typeof it.deletedAt === "string" ? it.deletedAt : null, hash: null });
    }
    if (!body.page?.hasMore || !body.page.cursor) return out;
    cursor = body.page.cursor;
  }
  throw new ImporterRefusal(`${collection}/${locale}: more than 20,000 items; refusing to page further`);
}

async function headHash(g: Gates, site: SiteRef, itemId: string): Promise<string | null> {
  const r = await webdeskContent.getItem(g.itemRead, site, itemId, {});
  const v = isObj(r.body) && isObj(r.body.version) ? r.body.version : null;
  if (!v) return null;
  if (Array.isArray(v.blocks) && isObj(v.seo)) return contentHashOf(v.blocks, v.seo);
  return typeof v.contentHash === "string" ? v.contentHash : null;
}

/** Plans every bundle item against what WebDesk holds. Reads only. */
async function planItems(
  g: Gates,
  site: SiteRef,
  bundle: Bundle,
  collectionsPresent: Set<string>,
): Promise<{ planned: PlannedItem[]; existing: Map<string, Existing> }> {
  const existing = new Map<string, Existing>(); // identity → Existing
  const pairs = new Map<string, { collection: string; locale: string }>();
  for (const i of bundle.items) pairs.set(`${i.collectionKey}\u0000${i.locale}`, { collection: i.collectionKey, locale: i.locale });
  for (const { collection, locale } of pairs.values()) {
    if (!collectionsPresent.has(collection)) continue; // not created yet: every item is a create
    const rows = await readExisting(g, site, collection, locale);
    for (const [slug, e] of rows) existing.set(identity({ collectionKey: collection, locale, slug }), e);
  }
  // The head content of every live existing item that the bundle also names (bounded concurrency).
  const wanted = orderedItems(bundle).filter((i) => {
    const e = existing.get(identity(i));
    return e && e.deletedAt === null;
  });
  const hashes = await mapPool(wanted, READ_CONCURRENCY, (i) => headHash(g, site, (existing.get(identity(i)) as Existing).itemId));
  wanted.forEach((i, k) => {
    (existing.get(identity(i)) as Existing).hash = hashes[k];
  });

  const planned: PlannedItem[] = orderedItems(bundle).map((item) => {
    const composition = bundle.compositions[item.collectionKey];
    const { blocks, seo } = assembledContent(item, composition);
    const hash = contentHashOf(blocks, seo);
    const e = existing.get(identity(item));
    if (!e) return { item, action: "create", hash };
    if (e.deletedAt !== null) return { item, action: "blocked", reason: "a deleted item still holds this slug (the importer cannot restore or delete)", itemId: e.itemId, headVersion: e.headVersion, hash };
    if (e.hash !== null && e.hash === hash) return { item, action: "skip", itemId: e.itemId, headVersion: e.headVersion, hash };
    return { item, action: "update", itemId: e.itemId, headVersion: e.headVersion, hash };
  });
  // A twin needs its source: in the bundle or already in WebDesk.
  for (const p of planned) {
    const t = p.item.twinOfSlug;
    if (t === undefined || p.action !== "create") continue;
    const sourceLocale = p.item.locale === "en" ? "id" : "en";
    const src = identity({ collectionKey: p.item.collectionKey, locale: sourceLocale, slug: t });
    if (!existing.has(src) && !bundle.items.some((o) => identity(o) === src)) {
      p.action = "blocked";
      p.reason = `twin source ${sourceLocale}/${t} is neither in the bundle nor in WebDesk`;
    }
  }
  return { planned, existing };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The run
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const emptyCounts = (): Record<ItemAction, number> => ({ create: 0, update: 0, skip: 0, blocked: 0 });

function summarise(planned: PlannedItem[], report: ImportReport): void {
  report.plan = {};
  report.totals = emptyCounts();
  for (const p of planned) {
    const byLocale = (report.plan[p.item.collectionKey] ??= {});
    const c = (byLocale[p.item.locale] ??= emptyCounts());
    c[p.action] += 1;
    report.totals[p.action] += 1;
  }
}

function printPlan(report: ImportReport, bundle: Bundle, site: SiteRef): void {
  const L = report.lines;
  L.push(`bundle ${bundle.site}  sha256 ${bundle.sha256}  vocabulary ${bundle.vocabularyVersion}  items ${bundle.items.length}  source ${bundle.sourceCommit.slice(0, 12)}`);
  L.push(`target ${site.tenantSlug}/${site.siteId}  principal ${report.principalId}`);
  L.push(`compositions: ${report.compositions.apply.length} to apply, ${report.compositions.skip.length} unchanged`);
  L.push("");
  L.push("collection".padEnd(18) + "locale".padEnd(8) + "create".padStart(8) + "update".padStart(8) + "skip".padStart(8) + "blocked".padStart(9));
  for (const col of Object.keys(report.plan).sort()) {
    for (const loc of Object.keys(report.plan[col]).sort()) {
      const c = report.plan[col][loc];
      L.push(col.padEnd(18) + loc.padEnd(8) + String(c.create).padStart(8) + String(c.update).padStart(8) + String(c.skip).padStart(8) + String(c.blocked).padStart(9));
    }
  }
  const t = report.totals;
  L.push("TOTAL".padEnd(26) + String(t.create).padStart(8) + String(t.update).padStart(8) + String(t.skip).padStart(8) + String(t.blocked).padStart(9));
}

/** Runs one import. Throws `ImporterRefusal` for refusals; everything else is in the report. */
export async function runImport(opts: ImportOptions, env: NodeJS.ProcessEnv = process.env): Promise<ImportReport> {
  if (opts.requestPublish && !opts.apply) {
    throw new ImporterRefusal("--request-publish needs --apply (a dry run makes zero writes, and filing an approval is a write)");
  }
  if (!UUID_RE.test(opts.tenantId)) throw new ImporterRefusal("--tenant-id must be the ERP company id (uuid)");
  const principal = await resolveImporterPrincipal(opts.principalId, env);
  const bundle = loadBundle(opts.bundlePath);
  const site = opts.site;
  const report: ImportReport = {
    dryRun: !opts.apply,
    bundleSha256: bundle.sha256,
    principalId: opts.principalId,
    compositions: { apply: [], skip: [] },
    plan: {},
    totals: emptyCounts(),
    writes: { schemaApplied: 0, created: 0, updated: 0, unchanged: 0, versionsWritten: 0 },
    failures: [],
    publishApprovalId: null,
    publishPreview: null,
    lines: [],
  };

  // Authorise FIRST, as the importer (Cerbos), then touch WebDesk. The wall (`resolveEditableSite`) is inside
  // the service, but resolving the site up front gives one clean refusal for a wrong tenant/site pair.
  const gates: Gates = {
    collRead: await authorizeContent(principal, opts.tenantId, "webdesk_collection", "read"),
    itemRead: await authorizeContent(principal, opts.tenantId, "webdesk_content_item", "read"),
  };
  await resolveEditableSite(opts.tenantId, site.tenantSlug, site.siteId);

  // ── compositions ─────────────────────────────────────────────────────────────────────────────
  let present = await readCollections(gates, site);
  for (const key of Object.keys(bundle.compositions).sort()) {
    const have = present.get(key);
    (have !== undefined && canonicalize(have) === canonicalize(bundle.compositions[key]) ? report.compositions.skip : report.compositions.apply).push(key);
  }

  if (opts.apply && report.compositions.apply.length > 0) {
    const schemaGate = await authorizeContent(principal, opts.tenantId, "webdesk_collection", "apply_schema");
    void schemaGate; // proof of the right; `controlApplySchema` is the egress and takes the principal itself
    for (const key of report.compositions.apply) {
      try {
        await controlApplySchema(
          principal,
          opts.tenantId,
          { tenantSlug: site.tenantSlug, siteId: site.siteId, collectionKey: key, schema: bundle.compositions[key] },
          `import:${bundle.sha256}:schema:${key}`,
        );
        report.writes.schemaApplied += 1;
      } catch (err) {
        // A MAJOR change is refused by WebDesk (409 contract-major-change): the importer never forces one.
        report.failures.push({ where: `schema ${key}`, reason: describe(err) });
        printPlanStub(report);
        return report; // items depend on their compositions: stop before writing any
      }
    }
    present = await readCollections(gates, site);
  }

  // ── plan ───────────────────────────────────────────────────────────────────────────────────────
  const { planned } = await planItems(gates, site, bundle, new Set(present.keys()));
  summarise(planned, report);

  if (!opts.apply) {
    report.lines.push("DRY RUN: nothing was written. Re-run with --apply to write.");
    printPlan(report, bundle, site);
    if (planned.some((p) => p.action === "blocked")) {
      for (const p of planned.filter((q) => q.action === "blocked")) report.lines.push(`  blocked ${p.item.collectionKey}/${p.item.locale}/${p.item.slug}: ${p.reason}`);
    }
    report.publishPreview = previewPublish(planned);
    return report;
  }

  // ── upsert items (sequential: twins need their source's id; one writer keeps the ledger readable) ──
  const createGate = await authorizeContent(principal, opts.tenantId, "webdesk_content_item", "create");
  const updateGate = await authorizeContent(principal, opts.tenantId, "webdesk_content_item", "update");
  const ids = new Map<string, string>(); // identity → itemId (existing, then created)
  for (const p of planned) if (p.itemId) ids.set(identity(p.item), p.itemId);
  const note = `${NOTE_PREFIX} ${bundle.sha256.slice(0, 12)}`;

  for (const p of planned) {
    const it = p.item;
    const label = `${it.collectionKey}/${it.locale}/${it.slug}`;
    if (p.action === "blocked") {
      report.failures.push({ where: label, reason: p.reason ?? "blocked" });
      continue;
    }
    if (p.action === "skip") continue;
    try {
      if (p.action === "create") {
        let twinOf: string | undefined;
        if (it.twinOfSlug !== undefined) {
          twinOf = ids.get(identity({ collectionKey: it.collectionKey, locale: it.locale === "en" ? "id" : "en", slug: it.twinOfSlug }));
          if (!twinOf) throw new ImporterRefusal(`twin source for ${label} has no item id (its own create failed)`);
        }
        const r = await webdeskContent.createItem(
          createGate,
          site,
          it.collectionKey,
          {
            locale: it.locale,
            slug: it.slug,
            ...(twinOf ? { twinOf } : {}),
            fields: it.fields,
            ...(it.blocks !== undefined ? { blocks: it.blocks } : {}),
            seo: it.seo,
            note,
          },
          idempotencyKeyFor(bundle.sha256, it),
        );
        const newId = (r.body as { item?: { itemId?: string } }).item?.itemId;
        if (typeof newId === "string") ids.set(identity(it), newId);
        report.writes.created += 1;
        report.writes.versionsWritten += 1;
      } else {
        const r = await webdeskContent.updateItem(
          updateGate,
          site,
          p.itemId as string,
          {
            baseVersion: p.headVersion,
            fields: it.fields,
            ...(it.blocks !== undefined ? { blocks: it.blocks } : {}),
            seo: it.seo,
            note,
          },
          // Same key family, plus the version it was based on: re-running the SAME bundle after a person edited
          // the item must not collide with the key an earlier update of that item already used.
          idempotencyKeyFor(bundle.sha256, it, `:b${p.headVersion}`),
        );
        if ((r.body as { unchanged?: boolean }).unchanged === true) report.writes.unchanged += 1;
        else {
          report.writes.updated += 1;
          report.writes.versionsWritten += 1;
        }
      }
    } catch (err) {
      report.failures.push({ where: label, reason: describe(err) });
      // A refusal of the channel itself (503: breaker open, signer or channel not configured) will repeat for
      // every remaining item: stop instead of writing 300 ledger rows of the same failure.
      if (statusOf(err) === 503) {
        report.failures.push({ where: "(run)", reason: "stopped after a 503: the control channel is unavailable. Fix it and re-run; re-runs are no-ops for what landed." });
        break;
      }
    }
  }
  printPlan(report, bundle, site);
  report.lines.push(
    `APPLIED: schemas ${report.writes.schemaApplied}, created ${report.writes.created}, updated ${report.writes.updated}, ` +
      `unchanged ${report.writes.unchanged}, versions written ${report.writes.versionsWritten}, failures ${report.failures.length}`,
  );

  // ── ONE publish approval ───────────────────────────────────────────────────────────────────────
  if (opts.requestPublish) {
    if (report.failures.length > 0) {
      report.failures.push({ where: "request-publish", reason: "not filed: the import had failures. Fix them and re-run with --apply --request-publish" });
    } else {
      try {
        report.publishApprovalId = await fileBatchApproval(principal, opts, bundle, gates);
        report.lines.push(`PUBLISH REQUEST FILED: approval ${report.publishApprovalId} (pending the owner's decision; the importer cannot publish)`);
      } catch (err) {
        report.failures.push({ where: "request-publish", reason: describe(err) });
      }
    }
  }
  return report;
}

function printPlanStub(report: ImportReport): void {
  report.lines.push(`STOPPED: a composition was refused; no item was written. ${report.failures.map((f) => `${f.where}: ${f.reason}`).join("; ")}`);
}

function statusOf(err: unknown): number | null {
  const s = (err as { getStatus?: () => number } | null)?.getStatus?.();
  return typeof s === "number" ? s : null;
}

function describe(err: unknown): string {
  if (err instanceof WebdeskProblem) {
    return `${err.getStatus()} ${problemSlug(err.problem) ?? "problem"}${typeof err.problem.detail === "string" ? `: ${err.problem.detail}` : ""}`;
  }
  const resp = (err as { getResponse?: () => unknown } | null)?.getResponse?.();
  if (isObj(resp)) return `${statusOf(err) ?? ""} ${String(resp.message ?? "")}${resp.reason ? ` (${String(resp.reason)})` : ""}`.trim();
  return err instanceof Error ? err.message : String(err);
}

// ── publish request ──────────────────────────────────────────────────────────────────────────────

function previewPublish(planned: PlannedItem[]): ImportReport["publishPreview"] {
  const counts: Record<string, number> = {};
  for (const p of planned) counts[p.item.collectionKey] = (counts[p.item.collectionKey] ?? 0) + 1;
  if (planned.length > MAX_PUBLISH_ITEMS) return { refused: `${planned.length} items exceeds the ${MAX_PUBLISH_ITEMS}-item limit of one command` };
  const notReady = planned.filter((p) => p.action !== "skip").length;
  // In a dry run an unapplied item has no head to name: say what it would take, file nothing.
  return notReady > 0 ? { refused: `${notReady} item(s) are not yet at the bundle's content: --apply first` } : { items: planned.length, counts };
}

/** Files ONE `content.publish` approval naming every bundle item at its head version. Re-reads first: the
 *  approval must name what WebDesk holds now, and every head must BE the bundle's content. */
async function fileBatchApproval(principal: Principal, opts: ImportOptions, bundle: Bundle, gates: Gates): Promise<string> {
  const site = opts.site;
  const present = await readCollections(gates, site);
  const { planned } = await planItems(gates, site, bundle, new Set(present.keys()));
  const off = planned.filter((p) => p.action !== "skip");
  if (off.length > 0) {
    throw new ImporterRefusal(
      `${off.length} item(s) are not at the bundle's content (first: ${off[0].item.collectionKey}/${off[0].item.locale}/${off[0].item.slug} is ${off[0].action}); not filing`,
    );
  }
  if (planned.length > MAX_PUBLISH_ITEMS) throw new ImporterRefusal(`${planned.length} items exceeds the ${MAX_PUBLISH_ITEMS}-item limit of one publish command`);
  if (planned.length === 0) throw new ImporterRefusal("the bundle has no items");

  // The same per-(collection, locale) Cerbos check WSK-59's requestPublish makes, with the attributes read from WebDesk.
  const pairs = new Map<string, { collectionKey: string; locale: string }>();
  for (const p of planned) pairs.set(`${p.item.collectionKey}\u0000${p.item.locale}`, { collectionKey: p.item.collectionKey, locale: p.item.locale });
  for (const pr of pairs.values()) {
    await authorize(principal, { kind: "webdesk_content_item", tenantId: opts.tenantId, module: "webdev", collectionKey: pr.collectionKey, locale: pr.locale }, "request_publish");
  }

  // One filing per bundle: a second --request-publish while the first is pending is a mistake, not a retry.
  const dup = await withTenants([opts.tenantId], (c) =>
    c.query<{ id: string }>(
      `SELECT id FROM automation_approvals
        WHERE origin = 'webdesk' AND workflow_id = 'content.publish' AND status = 'pending' AND deleted_at IS NULL
          AND tool_args->>'tenantSlug' = $1 AND tool_args->>'siteId' = $2 AND tool_args->'summary'->>'bundleSha256' = $3
        LIMIT 1`,
      [site.tenantSlug, site.siteId, bundle.sha256],
    ),
  );
  if (dup.rows[0]) throw new ImporterRefusal(`a publish approval for this bundle is already pending: ${dup.rows[0].id}`);

  const counts: Record<string, number> = {};
  for (const p of planned) counts[p.item.collectionKey] = (counts[p.item.collectionKey] ?? 0) + 1;
  const items = planned.map((p) => ({ itemId: p.itemId as string, version: p.headVersion as number, contentHash: p.hash }));
  const { approvalId } = await fileWebdeskCommandApproval(principal, opts.tenantId, {
    command: "content.publish",
    tenantSlug: site.tenantSlug,
    siteId: site.siteId,
    args: { items },
    summary: { title: `Initial import of ${bundle.site}: ${planned.length} items, bundle sha256 ${bundle.sha256}`, counts, bundleSha256: bundle.sha256 },
  });
  return approvalId;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export function parseArgs(argv: string[]): ImportOptions {
  const flags = new Set(["--apply", "--request-publish"]);
  const valued = new Set(["--tenant-id", "--site", "--bundle", "--principal"]);
  const got = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) got.set(a, true);
    else if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new ImporterRefusal(`${a} needs a value`);
      got.set(a, v);
    } else throw new ImporterRefusal(`unknown argument ${a}`);
  }
  for (const r of valued) if (typeof got.get(r) !== "string") throw new ImporterRefusal(`${r} is required`);
  const siteArg = got.get("--site") as string;
  const slash = siteArg.indexOf("/");
  if (slash < 1 || slash === siteArg.length - 1 || siteArg.indexOf("/", slash + 1) !== -1) throw new ImporterRefusal("--site must be <tenantSlug>/<siteId>");
  return {
    tenantId: got.get("--tenant-id") as string,
    site: { tenantSlug: siteArg.slice(0, slash), siteId: siteArg.slice(slash + 1) },
    bundlePath: got.get("--bundle") as string,
    principalId: got.get("--principal") as string,
    apply: got.get("--apply") === true,
    requestPublish: got.get("--request-publish") === true,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    // A CLI is its own process: the editorial signer main.ts wires at boot is not registered here, so every
    // write would be refused unsent (503 editorial_signer_not_configured). Found on the live import, 2026-10-11.
    wireWebdeskEditorialSigner();
    const report = await runImport(parseArgs(argv));
    for (const l of report.lines) console.log(l);
    if (report.publishPreview) console.log(`publish request preview: ${JSON.stringify(report.publishPreview)}`);
    for (const f of report.failures) console.error(`FAILED ${f.where}: ${f.reason}`);
    return report.failures.length > 0 ? 1 : 0;
  } catch (err) {
    console.error(err instanceof ImporterRefusal ? `REFUSED: ${err.message}` : `ERROR: ${describe(err)}`);
    return err instanceof ImporterRefusal ? 3 : 2;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  void main().then((code) => process.exit(code));
}
