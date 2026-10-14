// DW-6k (docs/FRONTEND-BFF-CONTRACT.md §36) — the pure rules: the cache age, the open-comment count, the title, the export
// format table and the body parsing. No I/O, no clock of its own (`now` is always passed), so every rule is unit-tested
// without Postgres, Cerbos or Figma.
import type { FigmaComment } from "./client";

// ───────────────────────────────────────────── the cache (§36.3) ─────────────────────────────────────────────

/** A link's cached fields refresh when they are OLDER than this and someone reads the link. */
export const CACHE_TTL_MS = 10 * 60 * 1000;

/** True when the cache is due: never filled, or older than ten minutes at `now`. Exactly ten minutes old is still fresh. A
 *  `cachedAt` in the future (a clock step) counts as fresh: it is never a reason to call Figma on every read. */
export function isCacheDue(cachedAt: Date | string | null | undefined, now: Date): boolean {
  if (cachedAt === null || cachedAt === undefined) return true;
  const t = cachedAt instanceof Date ? cachedAt.getTime() : Date.parse(cachedAt);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > CACHE_TTL_MS;
}

// ─────────────────────────────────────────── open comments (§36.2) ───────────────────────────────────────────

/** The frame a comment is pinned to, if it is pinned to one. A comment on bare canvas coordinates (a `Vector`, or a
 *  `Region`) carries no `node_id`. */
function pinnedNode(c: FigmaComment): string | null {
  const m = c.client_meta;
  return m && typeof m === "object" && "node_id" in m && typeof m.node_id === "string" ? m.node_id : null;
}

/**
 * How many open comments a link shows: THREADS with no `resolved_at`.
 *   * A reply (`parent_id` set) is not a thread of its own, so it is never counted: a resolved thread's replies would
 *     otherwise inflate the number.
 *   * When the link names a frame (`nodeId`), only comments pinned to exactly that frame count; a comment on another frame
 *     or on bare canvas is off-node and does not. With no `nodeId` (the whole file) every open thread counts.
 */
export function countOpenComments(comments: readonly FigmaComment[], nodeId: string | null): number {
  let n = 0;
  for (const c of comments) {
    if (c.parent_id) continue;
    if (c.resolved_at) continue;
    if (nodeId !== null && pinnedNode(c) !== nodeId) continue;
    n++;
  }
  return n;
}

/** The cached title: the file name, and the frame name after it when the link names a frame. */
export function figmaTitle(fileName: string | null | undefined, nodeName: string | null | undefined): string | null {
  const f = (fileName ?? "").trim();
  const n = (nodeName ?? "").trim();
  if (!f && !n) return null;
  if (!f) return n;
  return n ? `${f} / ${n}` : f;
}

// ─────────────────────────────────────────────── exports (§36.4) ───────────────────────────────────────────────

export const EXPORT_FORMATS = ["png", "svg", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_SCALES = [1, 2, 3] as const;
export type ExportScale = (typeof EXPORT_SCALES)[number];

/** The format's own content type, saved on the asset. */
export const FORMAT_CONTENT_TYPE: Record<ExportFormat, string> = {
  png: "image/png",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/** The thumbnail is a small PNG: half scale keeps even a large frame light. */
export const THUMBNAIL_SCALE = 0.5;

export class FigmaRuleError extends Error {
  constructor(
    readonly httpStatus: 400 | 404 | 409 | 502 | 503,
    /** The machine token the contract names (`figma_not_connected`, `target_not_found`, ...). Leads `message`. */
    readonly token: string,
    text: string,
    readonly field?: string,
  ) {
    super(`${token}: ${text}`);
    this.name = "FigmaRuleError";
  }
}

export interface ExportInput { format: ExportFormat; scale: ExportScale }

/** `{ format: "png" | "svg" | "pdf", scale?: 1 | 2 | 3 }`. A scale on svg or pdf is accepted and ignored by Figma, so it is
 *  validated the same way and not refused. */
export function parseExportBody(body: unknown): ExportInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new FigmaRuleError(400, "bad_export", "the body must be an object with a format", "format");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.format !== "string" || !(EXPORT_FORMATS as readonly string[]).includes(b.format)) {
    throw new FigmaRuleError(400, "bad_export", "format must be png, svg or pdf", "format");
  }
  let scale: ExportScale = 1;
  if (b.scale !== undefined && b.scale !== null) {
    if (typeof b.scale !== "number" || !(EXPORT_SCALES as readonly number[]).includes(b.scale)) {
      throw new FigmaRuleError(400, "bad_export", "scale must be 1, 2 or 3", "scale");
    }
    scale = b.scale as ExportScale;
  }
  return { format: b.format as ExportFormat, scale };
}

/** An asset file name from a link title: no path characters, no control characters, bounded. */
export function exportFileName(title: string | null, format: ExportFormat): string {
  // eslint-disable-next-line no-control-regex
  const base = (title ?? "Figma design").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${base || "Figma design"}.${format}`;
}

// ───────────────────────────────────────────────── targets ─────────────────────────────────────────────────

export const TARGET_KINDS = ["pm_task", "work_request", "campaign_part"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export function parseTargetKind(raw: unknown): TargetKind {
  if (typeof raw === "string" && (TARGET_KINDS as readonly string[]).includes(raw)) return raw as TargetKind;
  throw new FigmaRuleError(400, "bad_target", "targetKind must be pm_task, work_request or campaign_part", "targetKind");
}
