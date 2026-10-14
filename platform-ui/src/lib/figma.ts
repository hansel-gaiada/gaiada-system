// DW-6k UI — Figma links on tasks, requests and campaign parts (docs/FRONTEND-BFF-CONTRACT.md §36). Pure and client-safe:
// the response shapes as the backend sends them (§36.8), the normalisers that refuse a malformed answer, the URL builders for
// the routes, and every sentence a person reads. The readers are in `figma-data.ts` and the writes in `figmaActions.ts`.
//
// THE RULE THIS FILE KEEPS: `null` is "not read yet", never zero. `openComments`, `title`, `lastModified` and `cachedAt` stay
// `null` through the normaliser, and `commentsText(null)` says so; it never prints "0 comments" for a count nobody read.

export const FIGMA_TARGET_KINDS = ["pm_task", "work_request", "campaign_part"] as const;
export type FigmaTargetKind = (typeof FIGMA_TARGET_KINDS)[number];

export const EXPORT_FORMATS = ["png", "svg", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type FigmaTokenType = "pat" | "oauth";

export interface FigmaLink {
  id: string;
  targetKind: FigmaTargetKind;
  targetId: string;
  fileKey: string;
  nodeId: string | null;
  /** As stored: `https://www.figma.com/<kind>/<key>` plus `?node-id=1-2` for a frame. Opens Figma at the frame. */
  url: string;
  title: string | null;
  lastModified: string | null;
  /** `null` = never read. Never `0` standing in for "unknown". */
  openComments: number | null;
  cachedAt: string | null;
  assetGroupId: string | null;
  /** The cache was due and could not be refreshed: the numbers are the old ones. */
  stale: boolean;
  /** Why (`figma_not_connected`, `figma_refused`, `figma_rate_limited`, `figma_not_found`, `figma_unavailable`). */
  refreshError: string | null;
}

export interface FigmaLinks {
  figmaConnected: boolean;
  items: FigmaLink[];
}

export interface FigmaConnection {
  connected: boolean;
  tokenType: FigmaTokenType | null;
}

export interface FigmaExport {
  linkId: string;
  assetId: string;
  assetGroupId: string;
  versionNo: number;
  name: string;
  contentType: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** One link, or null when the row is not one (no id or no url). */
export function normalizeLink(raw: unknown): FigmaLink | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const url = str(raw.url);
  const kind = FIGMA_TARGET_KINDS.find((k) => k === raw.targetKind);
  if (!id || !url || !kind) return null;
  const oc = raw.openComments;
  return {
    id,
    targetKind: kind,
    targetId: str(raw.targetId) ?? "",
    fileKey: str(raw.fileKey) ?? "",
    nodeId: str(raw.nodeId),
    url,
    title: str(raw.title),
    lastModified: str(raw.lastModified),
    // Only a real, non-negative integer is a count; anything else is "not read".
    openComments: typeof oc === "number" && Number.isInteger(oc) && oc >= 0 ? oc : null,
    cachedAt: str(raw.cachedAt),
    assetGroupId: str(raw.assetGroupId),
    stale: raw.stale === true,
    refreshError: str(raw.refreshError),
  };
}

/** `GET figma-links`: `{ figmaConnected, items }`. Null when the answer is not that shape: a broken read, not "no links". */
export function normalizeLinks(raw: unknown): FigmaLinks | null {
  if (!isObj(raw) || typeof raw.figmaConnected !== "boolean" || !Array.isArray(raw.items)) return null;
  return { figmaConnected: raw.figmaConnected, items: raw.items.flatMap((r) => { const l = normalizeLink(r); return l ? [l] : []; }) };
}

export function normalizeConnection(raw: unknown): FigmaConnection | null {
  if (!isObj(raw) || typeof raw.connected !== "boolean") return null;
  const t = raw.tokenType;
  return { connected: raw.connected, tokenType: raw.connected && (t === "pat" || t === "oauth") ? t : null };
}

export function normalizeExport(raw: unknown): FigmaExport | null {
  if (!isObj(raw)) return null;
  const linkId = str(raw.linkId);
  const assetId = str(raw.assetId);
  const assetGroupId = str(raw.assetGroupId);
  const v = raw.versionNo;
  if (!linkId || !assetId || !assetGroupId || typeof v !== "number" || !Number.isInteger(v)) return null;
  return { linkId, assetId, assetGroupId, versionNo: v, name: str(raw.name) ?? "the design", contentType: str(raw.contentType) ?? "" };
}

// ── routes ─────────────────────────────────────────────────────────────────────────────────────────

const root = (t: string) => `/api/${encodeURIComponent(t)}`;

/** `GET figma-links?targetKind=&targetId=` */
export const linksPath = (t: string, kind: FigmaTargetKind, targetId: string): string =>
  `${root(t)}/figma-links?${new URLSearchParams({ targetKind: kind, targetId }).toString()}`;
export const createLinkPath = (t: string): string => `${root(t)}/figma-links`;
export const linkPath = (t: string, linkId: string): string => `${root(t)}/figma-links/${encodeURIComponent(linkId)}`;
export const exportPath = (t: string, linkId: string): string => `${linkPath(t, linkId)}/export`;
export const connectionPath = (t: string): string => `${root(t)}/integrations/figma`;

/** The browser-facing thumbnail: platform-ui's own route, which forwards the session (`app/api/figma-links/[linkId]/thumbnail`). */
export const thumbnailSrc = (linkId: string): string => `/api/figma-links/${encodeURIComponent(linkId)}/thumbnail`;

/** The stored URL when it is a real https Figma address; null otherwise. It is only ever put in an href after this check. */
export function safeFigmaHref(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    if (u.hostname !== "www.figma.com" && u.hostname !== "figma.com") return null;
    return u.toString();
  } catch {
    return null;
  }
}

// ── words ──────────────────────────────────────────────────────────────────────────────────────────

/** Every token the backend puts at the start of `error` (§36.8), and what a person reads for it. */
const TOKEN_TEXT: Readonly<Record<string, string>> = {
  bad_figma_url: "That doesn't look like a Figma link. Paste the address of a Figma file or frame, such as figma.com/design/….",
  figma_not_connected: "Figma isn't connected for this company, so this can't be done yet. A manager can connect it under Tools & connections.",
  figma_refused: "Figma refused the company's token. A manager needs to replace it under Tools & connections.",
  figma_not_found: "Figma can't find that file or frame. It may have been moved or deleted, or not shared with the connected account.",
  figma_rate_limited: "Figma is limiting requests right now. Try again in a minute.",
  figma_unavailable: "Figma couldn't be reached. Try again in a moment.",
  figma_render_failed: "Figma couldn't render that design for export. Try again, or try another format.",
  export_too_large: "The exported file is larger than the Asset Library accepts (25 MB). Try a smaller scale or another format.",
  link_exists: "That file or frame is already linked here.",
  too_many_links: "This item already has 25 Figma links, the most it can hold. Remove one first.",
  link_not_found: "That link no longer exists. Reload the page.",
  target_not_found: "The item these designs belong to no longer exists.",
  bad_target: "These designs can't be attached to that kind of item.",
  bad_export: "Choose PNG, SVG or PDF, at scale 1, 2 or 3.",
  bad_token: "Paste the Figma token as one string with no spaces.",
  bad_token_type: "Choose Personal access token or OAuth.",
};

const known = (k: string): boolean => Object.prototype.hasOwnProperty.call(TOKEN_TEXT, k);

/** The leading machine token of a backend `error` (`"link_exists: that file…"`), or of `reason` when that names one. */
export function figmaErrorToken(error: string | undefined | null, reason?: string | null): string | null {
  if (reason && known(reason)) return reason;
  const m = /^([a-z][a-z_]*)(?::|\s|$)/.exec((error ?? "").trim());
  return m && known(m[1]) ? m[1] : null;
}

/** A refusal or failure in plain words. A 403 is a calm sentence about permission, whatever the message says. */
export function figmaErrorText(e: { status?: number; error?: string | null; reason?: string | null }): string {
  if (e.status === 401) return "Your session expired. Sign in again.";
  if (e.status === 403) return "You don't have permission to do that. Ask the item's owner or a manager.";
  const token = figmaErrorToken(e.error, e.reason);
  if (token) return TOKEN_TEXT[token];
  if (e.status === 404) return "That wasn't found. Reload the page.";
  return "That didn't work, and the reason wasn't one we recognise. Try again in a moment.";
}

/** Why a link is stale, as a clause. */
function staleReason(refreshError: string | null): string {
  switch (refreshError) {
    case "figma_not_connected": return "Figma isn't connected";
    case "figma_refused": return "Figma refused the token";
    case "figma_rate_limited": return "Figma is limiting requests";
    case "figma_not_found": return "Figma can't find this file or frame any more";
    case "figma_unavailable": return "Figma couldn't be reached";
    default: return "Figma couldn't be read just now";
  }
}

/** "Stale: …" for a link whose refresh failed. The numbers shown are the last ones read. */
export function staleText(link: Pick<FigmaLink, "refreshError">): string {
  return `Stale: these are the last values read from Figma. ${staleReason(link.refreshError)}.`;
}

/** "3 open comments"; `null` is "not read yet", never zero. */
export function commentsText(n: number | null): string {
  if (n === null) return "Comments not read yet";
  if (n === 0) return "No open comments";
  return n === 1 ? "1 open comment" : `${n} open comments`;
}

/** "changed 3 hours ago" from an ISO time; null when Figma has not been read, or the time is not one. `now` is passed in
 *  so a server-rendered section and its hydration agree. */
export function changedText(lastModified: string | null, now: number): string | null {
  if (!lastModified) return null;
  const t = Date.parse(lastModified);
  if (!Number.isFinite(t)) return null;
  const sec = Math.floor((now - t) / 1000);
  if (sec < 60) return "changed just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `changed ${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `changed ${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `changed ${day} day${day === 1 ? "" : "s"} ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `changed ${mon} month${mon === 1 ? "" : "s"} ago`;
  const yr = Math.floor(day / 365);
  return `changed ${yr} year${yr === 1 ? "" : "s"} ago`;
}

export const NOT_CONNECTED_LINE = "Figma isn't connected for this company";

/** The success line after an export, naming the new version. */
export function exportedText(format: ExportFormat, out: Pick<FigmaExport, "versionNo" | "name">): string {
  return `Exported as ${format.toUpperCase()}: version ${out.versionNo} of ${out.name} is in the Asset Library.`;
}

export function tokenTypeLabel(t: FigmaTokenType | null): string {
  return t === "oauth" ? "OAuth" : t === "pat" ? "Personal access token" : "Unknown type";
}

/** Where a manager (`company.manage`) is sent when Figma is not connected: the department's Tools & connections page. Null when
 *  there is nothing to say (connected, or the read failed), the person cannot manage, or no department is known. */
export function connectionsHrefFor(
  canManage: boolean,
  deptId: string | null | undefined,
  result: { kind: string; data?: { figmaConnected: boolean } },
): string | null {
  if (!canManage || !deptId || result.kind !== "ok" || result.data?.figmaConnected !== false) return null;
  return `/departments/${encodeURIComponent(deptId)}/connections`;
}
