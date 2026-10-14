// DW-6k (docs/FRONTEND-BFF-CONTRACT.md §36) — Figma links: the persistence, the cache and the export. Routes are in
// figma.controller.ts (routes only); the rules without I/O are in rules.ts and url.ts; every call to Figma goes through the
// injectable client in client.ts.
//
// ── THE CONNECTION (§36.1) ───────────────────────────────────────────────────────────────────────
// One `integration_connections` row per company: owner_kind 'company', owner_id = the company, provider 'figma'. The token is
// sealed by secret-box in `access_token_enc` (setConnectionTokens), and `meta.tokenType` says which kind it is: 'pat' (sent as
// `X-Figma-Token`) or 'oauth' (sent as a Bearer). The plaintext lives only inside `loadFigmaCredential`'s caller for the
// length of one request. It is never logged, never in an error, never in a response.
//
// ── THE CACHE (§36.3) ────────────────────────────────────────────────────────────────────────────
// `title`, `last_modified`, `open_comments` and `cached_at` are refreshed on READ when they are older than ten minutes. A
// refresh that fails, or that Figma answers with a 429, KEEPS the old values and the response carries `stale: true` and the
// reason in `refreshError`. Nothing retries: the next read, later, is the retry. After a 429 the rest of that read's links
// are not even attempted. An unconnected company, a refused token or a frame Figma no longer has is NEVER shown as "no
// comments" or as an empty file: the cached numbers stay (null if there never were any) and the reason is named.
//
// ── THUMBNAILS (§36.3) are rendered by Figma, expire, and are PROXIED: fetched per request and never stored.
//
// ── EXPORTS (§36.4) save through creative-save.ts, the SAME save path as `POST /creative/assets`. The first export starts
// the version group and records it on `figma_links.asset_group_id`; later exports are new versions of it.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { createConnection, getConnectionRow, revokeConnection, setConnectionTokens } from "../integrations.service";
import { decryptSecret } from "../secret-box";
import { latestLiveVersion } from "../creative-reviews";
import { saveCreativeAsset, type SavedAsset } from "../creative-save";
import {
  FigmaApiError, figmaClient,
  type FigmaComment, type FigmaCredential, type FigmaFileSummary, type FigmaTokenType,
} from "./client";
import {
  FigmaRuleError, FORMAT_CONTENT_TYPE, THUMBNAIL_SCALE, countOpenComments, exportFileName, figmaTitle, isCacheDue,
  type ExportInput, type TargetKind,
} from "./rules";
import { parseFigmaUrl, FigmaUrlError, type ParsedFigmaUrl } from "./url";

export const FIGMA_PROVIDER = "figma";
/** A target holds at most this many live links: one read refreshes every due link of the target, one at a time. */
export const MAX_LINKS_PER_TARGET = 25;
const EXPORT_MAX_BYTES = 25 * 1024 * 1024; // creative.controller.ts's MAX_BYTES: an export is an asset like any other
const THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024;
const TOKEN_MAX = 4096;

// ─────────────────────────────────────────────── errors ───────────────────────────────────────────────

/** The reason tokens a read can carry on a link, and the codes the thumbnail and export routes answer with. */
export type FigmaFailureToken =
  | "figma_not_connected" | "figma_refused" | "figma_rate_limited" | "figma_not_found" | "figma_unavailable";

/** A Figma call's failure as the token a link or a response carries. */
export function failureToken(e: unknown): FigmaFailureToken {
  if (e instanceof FigmaApiError) {
    if (e.kind === "refused") return "figma_refused";
    if (e.kind === "rate_limited") return "figma_rate_limited";
    if (e.kind === "not_found") return "figma_not_found";
  }
  return "figma_unavailable";
}

const FAILURE_TEXT: Record<FigmaFailureToken, string> = {
  figma_not_connected: "Figma is not connected for this company",
  figma_refused: "Figma refused the company's token",
  figma_rate_limited: "Figma is rate limiting this company's token; try again later",
  figma_not_found: "Figma has no such file or frame for the company's token",
  figma_unavailable: "Figma could not be reached or answered in an unexpected way",
};
const FAILURE_STATUS: Record<FigmaFailureToken, 409 | 502 | 503> = {
  figma_not_connected: 409, figma_refused: 409, figma_not_found: 409, figma_rate_limited: 503, figma_unavailable: 502,
};

/** The refusal a route answers with when a Figma call fails. */
export function ruleFromFailure(e: unknown): FigmaRuleError {
  if (e instanceof FigmaRuleError) return e;
  if (e instanceof FigmaApiError && e.kind === "render_failed") {
    return new FigmaRuleError(502, "figma_render_failed", "Figma could not render that design");
  }
  if (e instanceof FigmaApiError && e.kind === "too_large") {
    return new FigmaRuleError(502, "export_too_large", "the rendered file is larger than the Asset Library accepts");
  }
  const t = failureToken(e);
  return new FigmaRuleError(FAILURE_STATUS[t], t, FAILURE_TEXT[t]);
}

export const targetNotFound = () => new FigmaRuleError(404, "target_not_found", "target not found", "targetId");
export const linkNotFound = () => new FigmaRuleError(404, "link_not_found", "figma link not found");

// ─────────────────────────────────────────────── the connection ───────────────────────────────────────────────

export interface FigmaConnectionStatus { connected: boolean; tokenType: FigmaTokenType | null }

interface ConnRow { id: string; status: string; access_token_enc: string | null; meta: { tokenType?: string } | null }

async function loadConnRow(c: PoolClient, tenantId: string): Promise<ConnRow | null> {
  const r = await c.query<ConnRow>(
    `SELECT id, status, access_token_enc, meta FROM integration_connections
      WHERE tenant_id = $1 AND owner_kind = 'company' AND owner_id = $1 AND provider = $2 AND deleted_at IS NULL`,
    [tenantId, FIGMA_PROVIDER],
  );
  return r.rows[0] ?? null;
}

const tokenTypeOf = (meta: ConnRow["meta"]): FigmaTokenType => (meta?.tokenType === "oauth" ? "oauth" : "pat");

/** Whether the company has a linked Figma token, and of which kind. Never reveals the token. */
export async function figmaConnectionStatus(tenantId: string): Promise<FigmaConnectionStatus> {
  const row = await withTenants([tenantId], (c) => loadConnRow(c, tenantId));
  const connected = !!row && row.status === "linked" && !!row.access_token_enc;
  return { connected, tokenType: connected ? tokenTypeOf(row!.meta) : null };
}

/** The unsealed company credential for one call, or null when none is linked. A vault that cannot open it (key unset or
 *  changed) throws: the caller reports figma_unavailable rather than pretending the company is unconnected. */
export async function loadFigmaCredential(tenantId: string): Promise<FigmaCredential | null> {
  const row = await withTenants([tenantId], (c) => loadConnRow(c, tenantId));
  if (!row || row.status !== "linked" || !row.access_token_enc) return null;
  return { token: decryptSecret(row.access_token_enc), tokenType: tokenTypeOf(row.meta) };
}

/** Stores (or replaces) the company's Figma token, sealed, through the vault's own write path (createConnection then
 *  setConnectionTokens, the sequence the Bing connector uses). Returns the masked status only. */
export async function connectFigma(tenantId: string, tokenRaw: unknown, tokenTypeRaw: unknown, userId: string | null): Promise<FigmaConnectionStatus> {
  if (typeof tokenRaw !== "string" || !tokenRaw.trim()) {
    throw new FigmaRuleError(400, "bad_token", "token is required", "token");
  }
  const token = tokenRaw.trim();
  if (token.length > TOKEN_MAX || /\s/.test(token)) {
    throw new FigmaRuleError(400, "bad_token", "token must be one token with no spaces", "token");
  }
  let tokenType: FigmaTokenType = "pat";
  if (tokenTypeRaw === "pat" || tokenTypeRaw === "oauth") tokenType = tokenTypeRaw;
  else if (tokenTypeRaw !== undefined && tokenTypeRaw !== null) {
    throw new FigmaRuleError(400, "bad_token_type", "tokenType must be pat or oauth", "tokenType");
  }
  const conn = await createConnection(tenantId, {
    ownerKind: "company", ownerId: tenantId, provider: FIGMA_PROVIDER, scopes: [], meta: { tokenType }, createdBy: userId,
  });
  await setConnectionTokens(tenantId, conn.id, { accessToken: token });
  return { connected: true, tokenType };
}

/** Disconnects: the vault's soft revoke (tokens nulled, row kept). False when there was nothing to disconnect. */
export async function disconnectFigma(tenantId: string): Promise<boolean> {
  const row = await withTenants([tenantId], (c) => loadConnRow(c, tenantId));
  if (!row) return false;
  const full = await getConnectionRow(tenantId, row.id);
  if (!full || full.status === "revoked") return false;
  await revokeConnection(tenantId, row.id);
  return true;
}

// ─────────────────────────────────────────────── links ───────────────────────────────────────────────

export interface LinkRow {
  id: string;
  tenant_id: string;
  target_kind: TargetKind;
  target_id: string;
  file_key: string;
  node_id: string | null;
  url: string;
  title: string | null;
  last_modified: Date | null;
  open_comments: number | null;
  cached_at: Date | null;
  asset_group_id: string | null;
  created_by: string;
  created_at: Date;
}

const LINK_COLS = `id, tenant_id, target_kind, target_id, file_key, node_id, url, title, last_modified, open_comments,
                   cached_at, asset_group_id, created_by, created_at`;

export interface FigmaLinkView {
  id: string;
  targetKind: TargetKind;
  targetId: string;
  fileKey: string;
  nodeId: string | null;
  url: string;
  title: string | null;
  lastModified: string | null;
  /** null = never counted (or not countable now). NEVER 0 standing in for "unknown". */
  openComments: number | null;
  cachedAt: string | null;
  assetGroupId: string | null;
  createdBy: string;
  createdAt: string;
  /** True when the cache was due and could not be refreshed: the numbers above are the old ones. */
  stale: boolean;
  /** Why it is stale, as a token; null when it is not. */
  refreshError: FigmaFailureToken | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toView(r: LinkRow, stale: boolean, refreshError: FigmaFailureToken | null): FigmaLinkView {
  return {
    id: r.id, targetKind: r.target_kind, targetId: r.target_id, fileKey: r.file_key, nodeId: r.node_id, url: r.url,
    title: r.title, lastModified: iso(r.last_modified), openComments: r.open_comments, cachedAt: iso(r.cached_at),
    assetGroupId: r.asset_group_id, createdBy: r.created_by, createdAt: r.created_at.toISOString(),
    stale, refreshError,
  };
}

export async function getLink(tenantId: string, id: string): Promise<LinkRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const r = await withTenants([tenantId], (c) =>
    c.query<LinkRow>(`SELECT ${LINK_COLS} FROM figma_links WHERE id = $1 AND deleted_at IS NULL`, [id]),
  );
  return r.rows[0] ?? null;
}

/** Per-request memo: two links on one file share one file read and one comments read. */
interface Memo {
  files: Map<string, Promise<FigmaFileSummary>>;
  comments: Map<string, Promise<FigmaComment[]>>;
}
const newMemo = (): Memo => ({ files: new Map(), comments: new Map() });

function memoFile(m: Memo, cred: FigmaCredential, key: string): Promise<FigmaFileSummary> {
  let p = m.files.get(key);
  if (!p) { p = figmaClient().getFile(cred, key); m.files.set(key, p); }
  return p;
}
function memoComments(m: Memo, cred: FigmaCredential, key: string): Promise<FigmaComment[]> {
  let p = m.comments.get(key);
  if (!p) { p = figmaClient().getComments(cred, key); m.comments.set(key, p); }
  return p;
}

/** One refresh: the file, the frame's name, the comments, then ONE write. Throws FigmaApiError; writes nothing on a failure. */
async function refreshOne(tenantId: string, cred: FigmaCredential, link: LinkRow, memo: Memo): Promise<LinkRow> {
  const file = await memoFile(memo, cred, link.file_key);
  let nodeName: string | null = null;
  if (link.node_id) {
    nodeName = await figmaClient().getNodeName(cred, link.file_key, link.node_id);
    // A frame Figma no longer has is not "a frame with no comments".
    if (nodeName === null) throw new FigmaApiError("not_found", 404);
  }
  const comments = await memoComments(memo, cred, link.file_key);
  const open = countOpenComments(comments, link.node_id);
  const title = figmaTitle(file.name, nodeName);
  const at = new Date();
  const r = await withTenants([tenantId], (c) =>
    c.query<LinkRow>(
      `UPDATE figma_links SET title = $2, last_modified = $3::timestamptz, open_comments = $4, cached_at = $5::timestamptz
        WHERE id = $1 AND deleted_at IS NULL RETURNING ${LINK_COLS}`,
      [link.id, title, file.lastModified, open, at.toISOString()],
    ),
  );
  return r.rows[0] ?? link;
}

/** The links of one target, each refreshed first when its cache is due (§36.3). */
export async function listLinks(tenantId: string, kind: TargetKind, targetId: string): Promise<{ figmaConnected: boolean; items: FigmaLinkView[] }> {
  const rows = (await withTenants([tenantId], (c) =>
    c.query<LinkRow>(
      `SELECT ${LINK_COLS} FROM figma_links WHERE target_kind = $1 AND target_id = $2 AND deleted_at IS NULL ORDER BY created_at, id`,
      [kind, targetId],
    ),
  )).rows;

  let cred: FigmaCredential | null = null;
  let vaultFailed = false;
  if (rows.some((r) => isCacheDue(r.cached_at, new Date()))) {
    try {
      cred = await loadFigmaCredential(tenantId);
    } catch {
      vaultFailed = true;
    }
  }
  const connected = (await figmaConnectionStatus(tenantId)).connected;

  const memo = newMemo();
  let rateLimited = false;
  const items: FigmaLinkView[] = [];
  for (const row of rows) {
    if (!isCacheDue(row.cached_at, new Date())) { items.push(toView(row, false, null)); continue; }
    if (vaultFailed) { items.push(toView(row, true, "figma_unavailable")); continue; }
    if (!cred) { items.push(toView(row, true, "figma_not_connected")); continue; }
    if (rateLimited) { items.push(toView(row, true, "figma_rate_limited")); continue; }
    try {
      items.push(toView(await refreshOne(tenantId, cred, row, memo), false, null));
    } catch (e) {
      const t = failureToken(e);
      if (t === "figma_rate_limited") rateLimited = true;
      items.push(toView(row, true, t));
    }
  }
  return { figmaConnected: connected, items };
}

export interface CreateLinkInput { kind: TargetKind; targetId: string; url: unknown; userId: string }

/** Creates the link, then tries ONE refresh so it shows its title and comments at once. A link may be created while Figma is
 *  not connected or refuses the token: it is saved with an empty cache and the response says why it is stale. */
export async function createLink(tenantId: string, input: CreateLinkInput): Promise<FigmaLinkView> {
  let parsed: ParsedFigmaUrl;
  try {
    parsed = parseFigmaUrl(input.url);
  } catch (e) {
    if (e instanceof FigmaUrlError) throw new FigmaRuleError(400, "bad_figma_url", e.message.replace(/^bad_figma_url: /, ""), "url");
    throw e;
  }
  const id = newId();
  let row: LinkRow;
  try {
    row = await withTenants([tenantId], async (c) => {
      const n = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM figma_links WHERE target_kind = $1 AND target_id = $2 AND deleted_at IS NULL`,
        [input.kind, input.targetId],
      );
      if (n.rows[0].n >= MAX_LINKS_PER_TARGET) {
        throw new FigmaRuleError(409, "too_many_links", `a target holds at most ${MAX_LINKS_PER_TARGET} Figma links`);
      }
      const ins = await c.query<LinkRow>(
        `INSERT INTO figma_links (id, tenant_id, target_kind, target_id, file_key, node_id, url, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${LINK_COLS}`,
        [id, tenantId, input.kind, input.targetId, parsed.fileKey, parsed.nodeId, parsed.url, input.userId],
      );
      return ins.rows[0];
    });
  } catch (e) {
    const pg = e as { code?: string; constraint?: string };
    if (pg?.code === "23505" && pg.constraint === "ux_figma_links_target_file_node") {
      throw new FigmaRuleError(409, "link_exists", "that file or frame is already linked here");
    }
    throw e;
  }

  let cred: FigmaCredential | null = null;
  try {
    cred = await loadFigmaCredential(tenantId);
  } catch {
    return toView(row, true, "figma_unavailable");
  }
  if (!cred) return toView(row, true, "figma_not_connected");
  try {
    return toView(await refreshOne(tenantId, cred, row, newMemo()), false, null);
  } catch (e) {
    return toView(row, true, failureToken(e));
  }
}

/** Soft delete: frees the unique slot. The exported assets stay in the Asset Library (they are the ERP's own files). */
export async function deleteLink(tenantId: string, id: string): Promise<boolean> {
  const r = await withTenants([tenantId], (c) =>
    c.query(`UPDATE figma_links SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]),
  );
  return (r.rowCount ?? 0) > 0;
}

// ─────────────────────────────────────────────── thumbnail and export ───────────────────────────────────────────────

async function requireCredential(tenantId: string): Promise<FigmaCredential> {
  let cred: FigmaCredential | null;
  try {
    cred = await loadFigmaCredential(tenantId);
  } catch {
    throw ruleFromFailure(new FigmaApiError("unavailable"));
  }
  if (!cred) throw new FigmaRuleError(409, "figma_not_connected", FAILURE_TEXT.figma_not_connected);
  return cred;
}

/** The node to render: the link's frame, or the file's first page for a whole-file link. */
async function renderTarget(cred: FigmaCredential, link: LinkRow): Promise<{ nodeId: string; file: FigmaFileSummary }> {
  const file = await figmaClient().getFile(cred, link.file_key);
  const nodeId = link.node_id ?? file.firstPageId;
  if (!nodeId) throw new FigmaApiError("render_failed");
  return { nodeId, file };
}

/** A small PNG of the link, fetched now and never stored (§36.3). */
export async function fetchThumbnail(tenantId: string, link: LinkRow): Promise<{ bytes: Buffer; contentType: string }> {
  const cred = await requireCredential(tenantId);
  try {
    // A frame link needs no read of the file (one call fewer on every thumbnail); a whole-file link needs its first page.
    const nodeId = link.node_id ?? (await renderTarget(cred, link)).nodeId;
    const url = await figmaClient().renderNode(cred, link.file_key, nodeId, { format: "png", scale: THUMBNAIL_SCALE });
    const got = await figmaClient().download(url, THUMBNAIL_MAX_BYTES);
    return { bytes: got.bytes, contentType: "image/png" };
  } catch (e) {
    throw ruleFromFailure(e);
  }
}

export interface ExportResult extends SavedAsset {
  linkId: string;
  assetGroupId: string;
  name: string;
  contentType: string;
}

/** Renders the link, downloads the result and saves it as a creative_assets row through the shared save path: version 1 in a
 *  new group the first time (recorded on the link), a new version of that group every time after (§36.4). */
export async function exportLink(
  tenantId: string, userId: string, link: LinkRow, input: ExportInput, departmentId: string | null,
): Promise<ExportResult> {
  const cred = await requireCredential(tenantId);
  let bytes: Buffer;
  let nodeId: string;
  let file: FigmaFileSummary;
  try {
    ({ nodeId, file } = await renderTarget(cred, link));
    const url = await figmaClient().renderNode(cred, link.file_key, nodeId, { format: input.format, scale: input.scale });
    bytes = (await figmaClient().download(url, EXPORT_MAX_BYTES)).bytes;
  } catch (e) {
    throw ruleFromFailure(e);
  }

  const contentType = FORMAT_CONTENT_TYPE[input.format];
  const name = exportFileName(link.title ?? file.name, input.format);
  let groupId = "";
  const saved = await saveCreativeAsset({
    tenantId, userId, name, contentType, width: null, height: null, presetId: "figma", departmentId,
    // The record of where the pixels came from. `nodeId` is the node that was actually rendered (a whole-file link renders
    // the file's first page), so the same render can be asked of Figma again.
    grade: { source: "figma", fileKey: link.file_key, nodeId, lastModified: file.lastModified },
    graded: bytes, original: null, originalContentType: null, versionOf: null,
    hooks: {
      // Under the LINK row's lock, so two first exports cannot start two groups. A group whose every version was deleted
      // starts a fresh one (the save path would otherwise refuse with asset_deleted).
      beforeInsert: async (c) => {
        const cur = await c.query<{ asset_group_id: string | null }>(
          `SELECT asset_group_id FROM figma_links WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [link.id],
        );
        if (!cur.rows[0]) throw linkNotFound();
        const group = cur.rows[0].asset_group_id;
        if (!group) return { versionOf: null };
        const latest = await latestLiveVersion(c, tenantId, group);
        return { versionOf: latest ? latest.id : null };
      },
      afterInsert: async (c, s) => {
        groupId = s.versionGroupId;
        await c.query(`UPDATE figma_links SET asset_group_id = $2 WHERE id = $1`, [link.id, s.versionGroupId]);
      },
    },
  });
  return { ...saved, linkId: link.id, assetGroupId: groupId || saved.versionGroupId, name, contentType };
}
