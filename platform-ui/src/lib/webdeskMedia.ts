import "server-only";
// WSK-43c — the media library's server reads, and the one egress seam its server actions use.
//
// A NEW module on purpose: `platform-nest/.../webdesk-content-ui-contract.test.ts` loads `webdeskContent.ts`,
// `webdeskContentActions.ts`, `webdeskContentModel.ts` and `platform.ts` into nest's own test runner (nest's
// node_modules only), so nothing media-specific is added to those four. This file imports FROM them; they do
// not import it. The shapes and parsers are in `webdeskMediaModel.ts` (pure, shared with the browser).
//
// Same three rules as `webdeskContent.ts` (read its header): every media read goes through here; every 2xx body
// is validated before it is returned (a mismatch is `contract_drift`, never data); no path turns a refusal into
// an empty list. The two media-specific answers `resultFromError` cannot express are handled here:
//   * 404 `media-asset-not-found` is a real answer ("that asset is gone"), not "route not served";
//   * 409 `media-in-use` carries the list of items that still use the asset, which the delete dialog must show.
import { getMe, platformFetch, PlatformError } from "./platform";
import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import { problemOf, resultFromError, siteBase } from "./webdeskContent";
import type { WdResult } from "./webdeskContentModel";
import {
  MediaShapeError, parseMediaList, parseMediaUsage, readUsageItems,
  type MediaInUse, type MediaListBody, type MediaQuery, type MediaUsage, type MediaWriteResult,
} from "./webdeskMediaModel";

const enc = encodeURIComponent;

export const mediaBase = (company: string, tenantSlug: string, siteId: string) => `${siteBase(company, tenantSlug, siteId)}/media`;

function drift(e: MediaShapeError): WdResult<never> {
  return { kind: "unavailable", code: "contract_drift", reason: e.message };
}

function inUseOf(e: PlatformError): MediaInUse | WdResult<never> {
  const p = problemOf(e);
  try {
    const items = readUsageItems(p.ext.items, "media-in-use.items");
    const total = typeof p.ext.total === "number" && Number.isInteger(p.ext.total) && p.ext.total >= items.length ? p.ext.total : items.length;
    return { kind: "in_use", message: p.message, total, items };
  } catch (err) {
    return err instanceof MediaShapeError ? drift(err) : resultFromError(err);
  }
}

/** One BFF call for the media routes: egress, validate, and fold every failure into a result. */
export async function mediaCall<T>(path: string, userId: string, parse: (raw: unknown) => T, init: RequestInit = {}): Promise<MediaWriteResult<T>> {
  let raw: unknown;
  try {
    raw = await platformFetch<unknown>(path, userId, init);
  } catch (e) {
    if (e instanceof PlatformError) {
      const p = problemOf(e);
      if (e.status === 404 && p.slug === "media-asset-not-found") return { kind: "not_found", slug: "media-asset-not-found" };
      if (e.status === 409 && p.slug === "media-in-use") return inUseOf(e);
    }
    return resultFromError(e);
  }
  try {
    return { kind: "ok", data: parse(raw) };
  } catch (e) {
    return e instanceof MediaShapeError ? drift(e) : resultFromError(e);
  }
}

/** The `…/media?…` query string for a list read. Only the keys WebDesk's list takes; the BFF 400s any other. */
export function mediaListQuery(q: MediaQuery = {}): string {
  const p = new URLSearchParams();
  if (q.mime) p.set("mime", q.mime);
  if (q.q) p.set("q", q.q);
  if (q.tag) p.set("tag", q.tag);
  if (q.cursor) p.set("cursor", q.cursor);
  p.set("limit", String(Math.min(Math.max(q.limit ?? 48, 1), 100)));
  return p.toString();
}

export async function listMedia(userId: string, company: string, tenantSlug: string, siteId: string, q: MediaQuery = {}): Promise<WdResult<MediaListBody>> {
  const r = await mediaCall(`${mediaBase(company, tenantSlug, siteId)}?${mediaListQuery(q)}`, userId, parseMediaList);
  return r as WdResult<MediaListBody>; // a list read is never `in_use`
}

export async function getMediaUsage(userId: string, company: string, tenantSlug: string, siteId: string, assetId: string): Promise<WdResult<MediaUsage>> {
  const r = await mediaCall(`${mediaBase(company, tenantSlug, siteId)}/${enc(assetId)}/usage`, userId, parseMediaUsage);
  return r as WdResult<MediaUsage>;
}

/** The host WebDesk serves media from, for thumbnails (the asset's own `url` is only a path). Read on the server and
 *  handed to the browser as a prop: it is the same public origin `uploadUrl` is built on, not a secret. `null` when
 *  unset or not a plain https (or loopback http) origin, and the grid then shows type tiles, not broken images. */
export function mediaPublicBase(): string | null {
  const raw = (process.env.WEBDESK_PUBLIC_BASE_URL ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash) return null;
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

// ── The server actions' session -> company context (they are `"use server"`, so it cannot be exported from there) ──

export type MediaCtx = { userId: string; company: string };

export async function mediaCtx(): Promise<MediaCtx | WdResult<never>> {
  const userId = await getSessionUserId();
  if (!userId) return { kind: "unavailable", code: "upstream_error", reason: "session_expired" };
  const me = await getMe(userId);
  const company = await getActiveTenant(me);
  if (!company) return { kind: "unavailable", code: "upstream_error", reason: "no_active_company" };
  return { userId, company };
}

export const isMediaCtx = (c: MediaCtx | WdResult<never>): c is MediaCtx => "userId" in c;
