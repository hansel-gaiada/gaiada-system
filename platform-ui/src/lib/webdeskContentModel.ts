// WSK-44 — the WebDesk content workspace's CLIENT-SAFE model: wire types, the discriminated result
// vocabulary, and the pure helpers the editor, the history diff and the approvals renderer share.
//
// WHY THIS IS A THIRD FILE. The brief names `lib/webdeskContent.ts` (the readers) and
// `lib/webdeskContentActions.ts` (the writes), and both are server-only / "use server". The editor,
// though, is a client component and needs the same TYPES and a handful of zero-I/O functions at
// interaction time. `platform-ui/CLAUDE.md`'s "module trio" rule is exactly this: types + pure
// functions live in an un-guarded `X.ts`, because importing a `server-only` module from a client
// component fails `next build` and nothing else. (`import type` is erased, so types alone would
// have been fine — the pure FUNCTIONS are what need a home.)
//
// ── SOURCE OF EVERY SHAPE BELOW ─────────────────────────────────────────────────────────────────
// docs/plans/2026-10-10-webdesk-write-plane-design.md: §2.2 (FieldDef / composition), §3.2 (write
// bodies + `ItemWriteResult`), §3.4 (problem slugs), §4 (read projections), §6 (the approval's
// `tool_args`), §10 (the states). The WSK-59 BFF passes the Zone B projections through, so these ARE
// the wire types. Every one is validated at the boundary by `webdeskContent.ts` — a field the BFF
// does not send becomes an `unavailable/contract_drift` result there, never `undefined` in a render.
// Where the spec is silent or ambiguous the choice is marked `ASSUMPTION` so the later re-verify
// subtask can find it with one grep.

// ── Composition (§2.2) ───────────────────────────────────────────────────────────────────────────

export type PrimitiveName =
  | "text" | "richtext" | "media" | "relation" | "number" | "date" | "select" | "geo"
  | "group" | "boolean" | "markdown";

export const PRIMITIVE_NAMES: readonly PrimitiveName[] = [
  "text", "richtext", "media", "relation", "number", "date", "select", "geo", "group", "boolean", "markdown",
];

export type FieldWidget = "input" | "textarea" | "code";

export interface FieldUi {
  label?: string;
  help?: string;
  readOnly?: boolean;
  widget?: FieldWidget;
}

export interface FieldDef {
  name: string;
  primitive: PrimitiveName;
  required?: boolean;
  options?: string[];
  relationTo?: string;
  multiple?: boolean;
  fields?: FieldDef[];
  itemKey?: string;
  /** default true. `false` = locale-neutral: the default-locale item's value is authoritative. */
  localized?: boolean;
  ui?: FieldUi;
}

export interface CollectionComposition {
  fields?: FieldDef[];
  blocks?: string[];
  singleton?: boolean;
  /** default true. `false` => items exist only in the tenant's default locale. */
  localized?: boolean;
  ui?: { label: string; description?: string; group?: string; order?: number; titleField?: string };
  lint?: { placeholders?: unknown[] };
}

// ── Read projections (§4) ────────────────────────────────────────────────────────────────────────

/** `domain` is nullable in WebDesk (`environments.domain`): an environment can exist before it has a hostname. */
export interface EnvironmentRef { envId: string; name: string; domain: string | null; status: string }
export interface SiteRef { siteId: string; name: string; kind: string; environments: EnvironmentRef[] }
export interface TenantRef {
  slug: string; status: string; defaultLocale: string; locales: string[]; sites: SiteRef[];
}
/** ASSUMPTION: the BFF's `GET …/content/sites` returns §4's `tenant.list` body unchanged. */
export interface SitesBody { tenants: TenantRef[] }

export interface CollectionCounts {
  items: number;
  /** ASSUMPTION: `byLocale` is a `{ [locale]: count }` map (§4 names the key but not its shape). */
  byLocale: Record<string, number>;
  live: number;
  pendingChanges: number;
}
export interface CollectionSummary {
  key: string;
  composition: CollectionComposition;
  vocabularyVersion: string;
  counts: CollectionCounts;
  updatedAt: string;
}

export interface ItemRef {
  itemId: string;
  collectionKey: string;
  locale: string;
  slug: string;
  localizationGroupId: string;
  headVersion: number;
  publishedVersion: number | null;
  /** Kept as the backend's string: `draft | published | scheduled | unpublished` today. A value this
   *  UI has never seen must render verbatim, never be coerced to one it knows. */
  publishState: string;
  publishAt: string | null;
  unpublishAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
}

export interface ItemSummary {
  itemId: string;
  slug: string;
  locale: string;
  localizationGroupId: string;
  title: string | null;
  headVersion: number;
  publishedVersion: number | null;
  publishState: string;
  publishAt: string | null;
  unpublishAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
  /** `null` for a pre-0009 row: it has no version row, so no head author or time (WebDesk `headRow ? … : null`). */
  headCreatedAt: string | null;
  headCreatedBy: string | null;
  pendingChanges: boolean;
}

export interface Page { cursor: string | null; hasMore: boolean; limit: number }
export interface ItemListBody { items: ItemSummary[]; page: Page }

export interface Block { type: string; props?: unknown }

export interface VersionContent {
  n: number;
  contentHash: string;
  createdAt: string;
  createdBy: string | null;
  note: string | null;
  blocks: Block[];
  seo: Record<string, unknown>;
}

export interface GroupMember {
  locale: string; itemId: string; slug: string;
  headVersion: number; publishedVersion: number | null; publishState: string;
}

export interface Lint {
  unresolvedTokens: string[];
  /** `{ CONFIRM: 3, CLIENT: 1 }` — keyed by the composition's marker labels. */
  markers: Record<string, number>;
  /** Present ONLY when WebDesk could not run the lint (`item.get` sends `lint.unavailable`, a reason string — e.g. the
   *  collection's stored composition is invalid). The lists above are then EMPTY BY DEFAULT, not by finding: an empty
   *  list is a claim, so a reader must check this first and never show "no unresolved placeholders" when it is set. */
  unavailable?: string;
}

export interface ItemDetail {
  item: ItemRef;
  version: VersionContent;
  group: GroupMember[];
  lint: Lint;
}

export interface VersionRow {
  version: number; contentHash: string; createdAt: string; createdBy: string | null; note: string | null;
}
export interface VersionListBody { versions: VersionRow[]; page: Page }
/** ASSUMPTION: `item.versionGet` is "the full version" — a flat `VersionRow` plus `blocks` and `seo`
 *  (§4 does not nest it the way `item.get` nests `version`). */
export interface VersionFull extends VersionRow { blocks: Block[]; seo: Record<string, unknown> }

// ── Write results (§3.2) ─────────────────────────────────────────────────────────────────────────

export interface ItemWriteResult {
  item: ItemRef;
  version: { version: number; contentHash: string; createdAt: string };
  unchanged: boolean;
  lint: Lint;
  replayed: boolean;
}

// ── PROPOSED beyond WSK-59 (flagged in the WSK-44 report; see `webdeskContent.ts` header) ───────
// §10's states table needs three things WSK-59's route list does not carry. They are typed here so
// the UI is honest about them; each degrades to a named "not available" note when the route 404s.

export type BuildState = "rebuilding" | "live" | "unverified" | "failed";
export interface BuildStatus {
  build: {
    approvalId: string | null;
    kind: "publish" | "rebuild";
    requestedAt: string;
    publishedAt: string | null;
    state: BuildState;
    stagingUrl: string | null;
    verifiedAt: string | null;
  } | null;
  /** True when something was unpublished/deleted since the last staging rebuild (§9). */
  stagingStale: boolean;
}

// ── The approval row behind "Awaiting approval #…" (existing `GET /api/:t/automation-approvals/:id`)

/** `cancelled` = the requester withdrew it while pending (WSK-59 withdraw; migration 0083 widened the CHECK). */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";
export type ExecState = "not_applicable" | "pending" | "executing" | "executed" | "failed";

export interface WebdeskApprovalRow {
  id: string;
  workflowId: string;
  status: ApprovalStatus;
  executionStatus: ExecState | null;
  executionError: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  createdAt: string;
  reason: string | null;
  toolArgs: unknown;
}

/** One row of `GET …/publish-requests` (WSK-44b): the caller's own publish/schedule approvals for a site. */
export interface PublishRequestRow {
  approvalId: string;
  status: ApprovalStatus;
  createdAt: string;
  itemIds: string[];
  executionStatus: ExecState | null;
}

/** §6: `tool_args:{tenantSlug,siteId,items[{itemId,version,contentHash}],publishAt?,rebuild:'staging'}`;
 *  WSK-67 adds `{bundleSha256, counts}` on the importer's one bulk request. */
export interface WebdeskPublishArgs {
  tenantSlug: string;
  siteId: string;
  items: { itemId: string; version: number; contentHash: string | null }[];
  publishAt: string | null;
  rebuild: string | null;
  bundleSha256: string | null;
  counts: Record<string, number> | null;
}

// ── Results ──────────────────────────────────────────────────────────────────────────────────────

export interface Issue { path: string; message: string; expected?: string }

/** Why a read/write is "unavailable". `editorial_unavailable` is the BFF's 503 token (breaker open
 *  or egress failure) and is the ONE that gets the full-page notice. `contract_drift` means the BFF
 *  answered 2xx with a body that does not match the spec — a defect, rendered loudly. */
export type UnavailableCode = "editorial_unavailable" | "upstream_error" | "contract_drift" | "network";

export type WdResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "unavailable"; code: UnavailableCode; reason: string }
  | { kind: "forbidden"; reason: string }
  | { kind: "not_enabled"; reason: "module_disabled" | "not_served" }
  | { kind: "not_found"; slug: string }
  /** 409. `slug` is the problem type's last segment (`version-conflict`, `slug-taken`, …). */
  | { kind: "conflict"; slug: string; message: string; currentHeadVersion: number | null; currentContentHash: string | null; updatedAt: string | null }
  /** 400 / 422. `issues` are located by RFC 6901 pointer (§2.2 `ItemIssue.path`). */
  | { kind: "invalid"; issues: Issue[]; message: string };

export type WdOk<T> = Extract<WdResult<T>, { kind: "ok" }>;

// ── Two failures that need their own words (rendering decisions — the result shapes are unchanged) ─
// `resultFromError` folds both into `unavailable`, and the nest-side UI contract test pins those shapes, so the
// components recognise them here instead of the lib re-coding them.

/** `502 webdesk_ambiguous`: a write whose outcome is UNKNOWN (the BFF could not confirm whether Zone B applied it).
 *  The BFF puts the machine cause (`not_observed` | `reconcile_failed`) in `reason`, which is what `resultFromError`
 *  keeps (as `unavailable/upstream_error`); `webdesk_ambiguous` itself is accepted too for a problem document that
 *  carries it as its type. Never "saved", never "failed": the caller re-reads. */
export const AMBIGUOUS_REASONS: ReadonlySet<string> = new Set(["webdesk_ambiguous", "not_observed", "reconcile_failed"]);
export function isOutcomeUnknown(r: { kind: string; code?: string; reason?: string }): boolean {
  return r.kind === "unavailable" && r.code === "upstream_error" && typeof r.reason === "string" && AMBIGUOUS_REASONS.has(r.reason);
}
/** `what` is the thing the user tried to do, with its article: "the save", "the publish request". */
export const unconfirmedCopy = (what: string): string => `We couldn't confirm ${what}. Reload to see what happened.`;

/** `503 webdesk_not_configured` on `POST …/rebuild-requests`: the BFF's `reason` is exactly this token when the site
 *  has no staging rebuild target. (Other not-configured causes — `control_channel_not_configured`,
 *  `editorial_signer_not_configured` — carry their own reason and keep the generic notice.) */
export const REBUILD_NOT_CONFIGURED_REASON = "webdesk_not_configured";
export const REBUILD_NOT_CONFIGURED_COPY = "Staging rebuild isn't set up for this site.";

// ── Pointers (§2.2: `/blocks/0/props/faq/2/answer`) ──────────────────────────────────────────────

export const FIELDS_POINTER = "/blocks/0/props";

export function pointerSegment(key: string | number): string {
  return String(key).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function fieldPointer(...segments: (string | number)[]): string {
  return [FIELDS_POINTER, ...segments.map(pointerSegment)].join("/");
}

/** Issues at exactly `pointer`. */
export function issuesAt(issues: Issue[], pointer: string): Issue[] {
  return issues.filter((i) => i.path === pointer);
}

/** Issues at `pointer` or anywhere beneath it (so a group/list can say "3 problems inside"). */
export function issuesUnder(issues: Issue[], pointer: string): Issue[] {
  return issues.filter((i) => i.path === pointer || i.path.startsWith(`${pointer}/`));
}

// ── Splitting a stored version into what the form edits ─────────────────────────────────────────

/** §2.7: `redirect` is a SYSTEM collection whose field values live under `seo.redirect` with
 *  `blocks: []` (`fieldsCarrierFor('redirect') = 'seo.redirect'`). */
export const SEO_CARRIER_COLLECTIONS: ReadonlySet<string> = new Set(["redirect"]);

export interface EditableContent {
  fields: Record<string, unknown>;
  seo: Record<string, unknown>;
  /** Vocabulary blocks after the `fields` block — preserved verbatim, not editable here. */
  extraBlocks: Block[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function splitVersionContent(
  collectionKey: string,
  blocks: Block[],
  seo: Record<string, unknown>,
): EditableContent {
  if (SEO_CARRIER_COLLECTIONS.has(collectionKey)) {
    const { [collectionKey]: carried, ...restSeo } = seo;
    return {
      fields: isRecord(carried) ? { ...carried } : {},
      seo: restSeo,
      extraBlocks: blocks,
    };
  }
  const first = blocks[0];
  if (first && first.type === "fields") {
    return { fields: isRecord(first.props) ? first.props : {}, seo, extraBlocks: blocks.slice(1) };
  }
  return { fields: {}, seo, extraBlocks: blocks };
}

// ── Defaults ─────────────────────────────────────────────────────────────────────────────────────

/** The value a NEW row/item starts with. Optional scalars start absent (`undefined`) so an untouched
 *  optional field is omitted rather than stored as "" — the round trip must not invent values. */
export function defaultValueFor(def: FieldDef): unknown {
  if (def.multiple) return [];
  return defaultSingle(def);
}

function defaultSingle(def: FieldDef): unknown {
  switch (def.primitive) {
    case "group": {
      const out: Record<string, unknown> = {};
      for (const sub of def.fields ?? []) {
        const v = def.required || sub.required ? defaultValueFor(sub) : undefined;
        if (v !== undefined) out[sub.name] = v;
      }
      return out;
    }
    case "boolean": return false;
    case "text": case "markdown": case "richtext": return def.required ? "" : undefined;
    case "select": return undefined;
    case "number": case "date": case "media": case "relation": case "geo": return undefined;
  }
}

export function defaultFields(defs: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const v = d.required ? defaultValueFor(d) : d.multiple ? [] : undefined;
    if (v !== undefined) out[d.name] = v;
  }
  return out;
}

export function humanize(name: string): string {
  const s = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : name;
}

export function fieldLabel(def: FieldDef): string {
  return def.ui?.label ?? humanize(def.name);
}

// ── Equality / list moves ────────────────────────────────────────────────────────────────────────

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    // `undefined` and "absent" are the same thing on the wire (JSON drops it).
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** JSON-safe copy: drops `undefined` members the way the wire will. */
export function toWire<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null)) as T;
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list.slice();
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// ── Locale neutrality (§2.5 rule 2) ──────────────────────────────────────────────────────────────

export function isNeutral(def: FieldDef): boolean {
  return def.localized === false;
}

/** A group that CONTAINS a locale-neutral member somewhere below it. */
export function hasNeutralDescendant(def: FieldDef): boolean {
  if (def.localized === false) return true;
  return (def.fields ?? []).some(hasNeutralDescendant);
}

/**
 * "The editor renders them read-only and WRITES THE DEFAULT VALUE THROUGH" (§2.5 rule 2): on a
 * non-default locale, every locale-neutral member takes the default-locale item's value. Lists keyed
 * by `itemKey` are matched by key; a list without one cannot be matched safely and is left as typed
 * (its neutral members are read-only in the form, so they were never editable in the first place).
 */
export function writeNeutralsThrough(
  defs: FieldDef[],
  local: Record<string, unknown>,
  authoritative: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!authoritative) return local;
  const out: Record<string, unknown> = { ...local };
  for (const def of defs) {
    if (def.localized === false) {
      if (def.name in authoritative) out[def.name] = authoritative[def.name];
      else delete out[def.name];
      continue;
    }
    if (def.primitive !== "group" || !def.fields) continue;
    const mine = out[def.name];
    const theirs = authoritative[def.name];
    if (!def.multiple) {
      if (isRecord(mine) && isRecord(theirs)) out[def.name] = writeNeutralsThrough(def.fields, mine, theirs);
      continue;
    }
    if (!Array.isArray(mine) || !Array.isArray(theirs) || !def.itemKey) continue;
    const byKey = new Map<string, Record<string, unknown>>();
    for (const t of theirs) if (isRecord(t) && typeof t[def.itemKey] === "string") byKey.set(t[def.itemKey] as string, t);
    out[def.name] = mine.map((row) => {
      if (!isRecord(row)) return row;
      const k = row[def.itemKey as string];
      const match = typeof k === "string" ? byKey.get(k) : undefined;
      return match ? writeNeutralsThrough(def.fields ?? [], row, match) : row;
    });
  }
  return out;
}

/** What the id-locale form SHOWS for locale-neutral members: the default locale's value. */
export function overlayNeutrals(
  defs: FieldDef[],
  local: Record<string, unknown>,
  authoritative: Record<string, unknown> | null,
): Record<string, unknown> {
  return writeNeutralsThrough(defs, local, authoritative);
}

// ── Collections grouping (§10: Pages · Home sections · Company pages · Site settings · Redirects) ─

const PREFERRED_GROUP_ORDER = ["Pages", "Home sections", "Company pages", "Site settings", "Globals", "Redirects"];

export function collectionLabel(c: { key: string; composition: CollectionComposition }): string {
  return c.composition.ui?.label ?? humanize(c.key);
}

export interface CollectionGroup { group: string; collections: CollectionSummary[] }

export function groupCollections(collections: CollectionSummary[]): CollectionGroup[] {
  const map = new Map<string, CollectionSummary[]>();
  for (const c of collections) {
    const g = c.composition.ui?.group ?? "Other";
    const arr = map.get(g) ?? [];
    arr.push(c);
    map.set(g, arr);
  }
  const rank = (g: string) => {
    const i = PREFERRED_GROUP_ORDER.indexOf(g);
    return i >= 0 ? i : g === "Other" ? 1000 : 500;
  };
  return [...map.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([group, cs]) => ({
      group,
      collections: cs.slice().sort((a, b) => (a.composition.ui?.order ?? 999) - (b.composition.ui?.order ?? 999) || collectionLabel(a).localeCompare(collectionLabel(b))),
    }));
}

/** Version authors arrive as the ERP's opaque `users.id` (§3.3 `created_by` = the editorial `sub`). A name when the company directory knows it, otherwise a short id — never blank. */
export function authorLabel(createdBy: string | null, names: Record<string, string>): string {
  if (!createdBy) return "unknown author";
  return names[createdBy] ?? `user ${createdBy.slice(0, 8)}`;
}

// ── State vocabulary ─────────────────────────────────────────────────────────────────────────────

export function publishStateLabel(state: string): string {
  switch (state) {
    case "draft": return "Draft";
    case "published": return "Published";
    case "scheduled": return "Scheduled";
    case "unpublished": return "Unpublished";
    default: return humanize(state);
  }
}

/** `live` = the frozen read path is serving a published version to production keys. */
export function isLive(item: Pick<ItemRef, "publishedVersion" | "publishState" | "deletedAt">): boolean {
  return item.deletedAt === null && item.publishedVersion !== null && item.publishState === "published";
}

export function hasPendingChanges(item: Pick<ItemRef, "headVersion" | "publishedVersion">): boolean {
  return item.publishedVersion === null || item.headVersion !== item.publishedVersion;
}

// ── Reason tokens, in plain words (§10 "rejected / failed") ──────────────────────────────────────

const REASON_COPY: Record<string, string> = {
  "version-conflict": "Someone saved a newer version after this request was filed.",
  "published-version-changed": "The live version changed after this request was filed.",
  "item-is-live": "The item is live, so that action is not allowed.",
  "item-not-found": "The item no longer exists in WebDesk.",
  "not-live": "The item is not live.",
  "composition-violation": "The content no longer passes the collection's rules.",
  "editorial_unavailable": "WebDesk could not be reached when the publish ran.",
  "editorial-replay-store-unavailable": "WebDesk's editorial check was unavailable when the publish ran.",
  "editorial-keys-not-configured": "WebDesk's editorial signing is not configured.",
  "principal_unresolvable": "The approver's account could not be linked to an editorial identity.",
  "contract-major-change": "The change needs a major contract version, which is not allowed here.",
};

export function describeReasonToken(token: string | null | undefined): string {
  if (!token) return "No reason was recorded.";
  // The executor may prefix its own words (`failed: version-conflict`); match on the typed token.
  const bare = token.replace(/^[a-z ]+:\s*/i, "").trim();
  return REASON_COPY[bare] ?? REASON_COPY[token] ?? `Reason: ${token}`;
}

export type RequestPhase =
  | { phase: "pending"; approvalId: string }
  | { phase: "approved_publishing"; approvalId: string; decidedByName: string | null }
  | { phase: "executed"; approvalId: string; decidedByName: string | null }
  | { phase: "rejected"; approvalId: string; decidedByName: string | null }
  | { phase: "withdrawn"; approvalId: string }
  | { phase: "failed"; approvalId: string; reason: string; decidedByName: string | null };

/** The one mapping from the approval row to the UI phase. Pure so it is table-testable. */
export function phaseOf(row: Pick<WebdeskApprovalRow, "id" | "status" | "executionStatus" | "executionError" | "decidedByName" | "decidedBy">): RequestPhase {
  const decidedByName = row.decidedByName ?? row.decidedBy ?? null;
  if (row.status === "pending") return { phase: "pending", approvalId: row.id };
  if (row.status === "rejected") return { phase: "rejected", approvalId: row.id, decidedByName };
  // The requester withdrew it: nobody with authority refused it (that is `rejected`), and nothing ran.
  if (row.status === "cancelled") return { phase: "withdrawn", approvalId: row.id };
  // approved
  switch (row.executionStatus) {
    case "executed": return { phase: "executed", approvalId: row.id, decidedByName };
    case "failed": return { phase: "failed", approvalId: row.id, reason: describeReasonToken(row.executionError), decidedByName };
    // `null`/unknown is NOT "executed": a row from an older deployment that omits the column stays
    // "publishing" until the item read proves otherwise (CLAUDE.md: a missing field reads as null).
    default: return { phase: "approved_publishing", approvalId: row.id, decidedByName };
  }
}

// ── Parsing the approval's `tool_args` (never trusted) ──────────────────────────────────────────

export function parseWebdeskPublishArgs(raw: unknown): WebdeskPublishArgs | null {
  if (!isRecord(raw)) return null;
  const { tenantSlug, siteId, items } = raw;
  if (typeof tenantSlug !== "string" || typeof siteId !== "string" || !Array.isArray(items)) return null;
  const parsed: WebdeskPublishArgs["items"] = [];
  for (const it of items) {
    if (!isRecord(it) || typeof it.itemId !== "string" || typeof it.version !== "number") return null;
    parsed.push({ itemId: it.itemId, version: it.version, contentHash: typeof it.contentHash === "string" ? it.contentHash : null });
  }
  let counts: Record<string, number> | null = null;
  if (isRecord(raw.counts)) {
    const c: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.counts)) if (typeof v === "number") c[k] = v;
    counts = c;
  }
  return {
    tenantSlug,
    siteId,
    items: parsed,
    publishAt: typeof raw.publishAt === "string" ? raw.publishAt : null,
    rebuild: typeof raw.rebuild === "string" ? raw.rebuild : null,
    bundleSha256: typeof raw.bundleSha256 === "string" ? raw.bundleSha256 : null,
    counts,
  };
}

// ── Diff (history: "diff against live") ─────────────────────────────────────────────────────────

export interface FieldChange {
  pointer: string;
  label: string;
  kind: "changed" | "added" | "removed" | "reordered";
  before: string;
  after: string;
}

function preview(v: unknown): string {
  if (v === undefined) return "—";
  if (typeof v === "string") return v.length > 240 ? `${v.slice(0, 240)}…` : v === "" ? "(empty)" : v;
  const s = JSON.stringify(v);
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

function pushChange(out: FieldChange[], pointer: string, label: string, before: unknown, after: unknown) {
  if (deepEqual(before, after)) return;
  const kind: FieldChange["kind"] = before === undefined ? "added" : after === undefined ? "removed" : "changed";
  out.push({ pointer, label, kind, before: preview(before), after: preview(after) });
}

function diffValue(def: FieldDef, a: unknown, b: unknown, pointer: string, label: string, out: FieldChange[]) {
  if (deepEqual(a, b)) return;
  if (def.primitive === "group" && def.fields) {
    if (def.multiple && Array.isArray(a) && Array.isArray(b) && def.itemKey) {
      const key = def.itemKey;
      const keyOf = (row: unknown) => (isRecord(row) && typeof row[key] === "string" ? (row[key] as string) : null);
      const aKeys = a.map(keyOf);
      const bKeys = b.map(keyOf);
      if (aKeys.every((k) => k !== null) && bKeys.every((k) => k !== null)) {
        const aMap = new Map(a.map((r, i) => [aKeys[i] as string, { r, i }]));
        const bMap = new Map(b.map((r, i) => [bKeys[i] as string, { r, i }]));
        for (const [k, { r, i }] of bMap) {
          const prev = aMap.get(k);
          if (!prev) { out.push({ pointer: `${pointer}/${i}`, label: `${label} › ${k}`, kind: "added", before: "—", after: preview(r) }); continue; }
          diffGroup(def.fields, prev.r, r, `${pointer}/${i}`, `${label} › ${k}`, out);
        }
        for (const [k, { r, i }] of aMap) {
          if (!bMap.has(k)) out.push({ pointer: `${pointer}/${i}`, label: `${label} › ${k}`, kind: "removed", before: preview(r), after: "—" });
        }
        const common = aKeys.filter((k) => bMap.has(k as string)).join("\u0000");
        const commonB = bKeys.filter((k) => aMap.has(k as string)).join("\u0000");
        if (common !== commonB) out.push({ pointer, label, kind: "reordered", before: aKeys.join(", "), after: bKeys.join(", ") });
        return;
      }
    }
    if (!def.multiple) { diffGroup(def.fields, a, b, pointer, label, out); return; }
  }
  pushChange(out, pointer, label, a, b);
}

function diffGroup(defs: FieldDef[], a: unknown, b: unknown, pointer: string, label: string, out: FieldChange[]) {
  const ra = isRecord(a) ? a : {};
  const rb = isRecord(b) ? b : {};
  if (!isRecord(a) || !isRecord(b)) { pushChange(out, pointer, label, a, b); return; }
  for (const d of defs) diffValue(d, ra[d.name], rb[d.name], `${pointer}/${pointerSegment(d.name)}`, `${label} › ${fieldLabel(d)}`, out);
}

/** Field-level differences between two stored versions of one item, labelled from the composition. */
export function diffContent(
  composition: CollectionComposition,
  a: EditableContent,
  b: EditableContent,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const d of composition.fields ?? []) {
    diffValue(d, a.fields[d.name], b.fields[d.name], fieldPointer(d.name), fieldLabel(d), out);
  }
  pushChange(out, "/seo/title", "SEO title", a.seo.title, b.seo.title);
  pushChange(out, "/seo/description", "SEO description", a.seo.description, b.seo.description);
  return out;
}

// ── Tiny safe markdown preview (no dependency, no innerHTML) ─────────────────────────────────────
// The editor's markdown field shows a preview next to the source. platform-ui carries four runtime
// deps and a markdown parser is not going to be the fifth. This is a PREVIEW of structure
// (headings, lists, paragraphs, emphasis, code, links) — the stored value is the verbatim source and
// is never re-serialised from this. Output is plain data the component maps to React elements, so
// no HTML string is ever built from user text.

export type MdInline =
  | { t: "text"; v: string }
  | { t: "strong"; v: string }
  | { t: "em"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; v: string; href: string };
export type MdBlock =
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: MdInline[] }
  | { t: "p"; inline: MdInline[] }
  | { t: "ul"; items: MdInline[][] }
  | { t: "ol"; items: MdInline[][] }
  | { t: "pre"; v: string }
  | { t: "hr" };

const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i;

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push({ t: "text", v: src.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("**")) out.push({ t: "strong", v: tok.slice(2, -2) });
    else if (tok.startsWith("`")) out.push({ t: "code", v: tok.slice(1, -1) });
    else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (mm && SAFE_HREF.test(mm[2])) out.push({ t: "link", v: mm[1], href: mm[2] });
      else out.push({ t: "text", v: tok });
    } else out.push({ t: "em", v: tok.slice(1, -1) });
    last = m.index + tok.length;
  }
  if (last < src.length) out.push({ t: "text", v: src.slice(last) });
  return out;
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ t: "p", inline: parseInline(para.join(" ")) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      blocks.push({ t: "pre", v: code.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); blocks.push({ t: "h", level: h[1].length as 1 | 2 | 3 | 4 | 5 | 6, inline: parseInline(h[2]) }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ t: "hr" }); continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flush();
      const ordered = !!ol;
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const m = (ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/).exec(lines[i]);
        if (!m) break;
        items.push(parseInline(m[1]));
        i++;
      }
      i--;
      blocks.push(ordered ? { t: "ol", items } : { t: "ul", items });
      continue;
    }
    if (line.trim() === "") { flush(); continue; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}
