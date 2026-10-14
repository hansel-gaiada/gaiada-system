// DW-6k (docs/FRONTEND-BFF-CONTRACT.md §36.3) — the ONE thin, injectable Figma REST client. Server side only.
//
// ── WHERE THE TYPES COME FROM ────────────────────────────────────────────────────────────────────
// Every response type below holds ONLY fields Figma documents. Sources, read on 2026-10-14:
//   * Figma's official REST API OpenAPI description (the machine-readable form of the developer docs):
//       https://github.com/figma/rest-api-spec  (openapi/openapi.yaml, version 0.44.0)
//       https://raw.githubusercontent.com/figma/rest-api-spec/main/openapi/openapi.yaml
//     schemas used: GetFileResponse, GetFileNodesResponse, GetImagesResponse, GetCommentsResponse, Comment, FrameOffset,
//     FrameOffsetRegion, Region, Vector, DocumentNode, CanvasNode and IsLayerTrait (a layer's `id` and `name`), and
//     `components.securitySchemes` (PersonalAccessToken: header `X-Figma-Token`; OAuth2).
//   * The developer docs pages, for the same endpoints and for the error and rate-limit behaviour:
//       https://developers.figma.com/docs/rest-api/file-endpoints/        (GET file, GET file nodes, GET images; the `nodes`
//                                                                           map and the `images` map may hold null values)
//       https://developers.figma.com/docs/rest-api/comments-endpoints/    (GET comments)
//       https://developers.figma.com/docs/rest-api/comments-types/        (the Comment type)
//       https://developers.figma.com/docs/rest-api/rate-limits/           (429 and Retry-After)
//       https://developers.figma.com/docs/rest-api/errors/                (400, 403, 404, 429, 500)
//       https://developers.figma.com/docs/rest-api/authentication/
// The OpenAPI file names two ways to authenticate: a personal access token in the `X-Figma-Token` header, and OAuth 2, whose
// access token is a standard Bearer credential (`Authorization: Bearer <token>`).
//
// ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────────────────────────
//   * No retry loop and no backoff: a 429 or a failure is reported once and the caller marks the link stale (§36.3). Another
//     read, later, is the retry.
//   * No token is ever logged, placed in an error message, or returned. FigmaApiError carries a kind and a status only.
//   * Nothing here knows Postgres, Cerbos or the vault: the caller hands the client an already-unsealed credential.
import type { ExportFormat } from "./rules";

// ─────────────────────────────────────── the documented response shapes ───────────────────────────────────────

/** `Vector`: a 2d vector. */
export interface FigmaVector { x: number; y: number }
/** `FrameOffset`: a comment's position relative to the frame it is attached to. */
export interface FigmaFrameOffset { node_id: string; node_offset: FigmaVector }
/** `Region`: a region comment on bare canvas. */
export interface FigmaRegion {
  x: number; y: number; region_height: number; region_width: number;
  comment_pin_corner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}
/** `FrameOffsetRegion`: a region comment relative to a frame. */
export interface FigmaFrameOffsetRegion {
  node_id: string; node_offset: FigmaVector; region_height: number; region_width: number;
  comment_pin_corner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

/** `Comment`, the fields this module reads. `resolved_at` is a UTC ISO 8601 time, or null/absent while open. `parent_id` is
 *  present on a reply. `client_meta` carries the frame in `node_id` when the comment is pinned to one. */
export interface FigmaComment {
  id: string;
  parent_id?: string;
  created_at: string;
  resolved_at?: string | null;
  client_meta: FigmaVector | FigmaFrameOffset | FigmaRegion | FigmaFrameOffsetRegion;
}

/** `GET /v1/files/{file_key}` (shallow): `name`, `lastModified`, and `document.children`, the file's pages (CANVAS nodes,
 *  each a layer with `id` and `name`). */
export interface FigmaGetFileResponse {
  name: string;
  lastModified: string;
  document?: { children?: Array<{ id: string; name: string }> };
}

/** `GET /v1/files/{file_key}/nodes`: `nodes` maps a node id to `{ document }`, where `document` is a layer with `name`. The
 *  docs warn that a value may be null. */
export interface FigmaGetFileNodesResponse {
  name?: string;
  lastModified?: string;
  nodes: Record<string, { document: { id?: string; name: string } } | null>;
}

/** `GET /v1/images/{file_key}`: `images` maps a node id to the URL of its render, or null where that render failed; `err` is
 *  null on success. */
export interface FigmaGetImagesResponse {
  err?: string | null;
  images: Record<string, string | null>;
}

/** `GET /v1/files/{file_key}/comments`. */
export interface FigmaGetCommentsResponse { comments: FigmaComment[] }

// ─────────────────────────────────────────────── the client ───────────────────────────────────────────────

export type FigmaTokenType = "pat" | "oauth";
/** An already-unsealed company credential. Lives only for the duration of one call. */
export interface FigmaCredential { token: string; tokenType: FigmaTokenType }

export type FigmaErrorKind =
  | "refused"      // 401 / 403: the token is not accepted, or may not read this file
  | "not_found"    // 404: no such file (or node) for this token
  | "rate_limited" // 429
  | "bad_request"  // 400: Figma rejected the parameters
  | "render_failed"// the images map held null for the node (or the render could not be fetched)
  | "too_large"    // the rendered file is bigger than the caller allows
  | "unavailable"; // network, timeout, 5xx, or a body that does not have the documented shape

/** A failed Figma call. Carries the kind and, for a 429, Figma's Retry-After seconds. NEVER the token or a request header. */
export class FigmaApiError extends Error {
  constructor(readonly kind: FigmaErrorKind, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(`figma ${kind}${status ? ` (${status})` : ""}`);
    this.name = "FigmaApiError";
  }
}

export interface FigmaFileSummary { name: string; lastModified: string; firstPageId: string | null }
export interface RenderOptions { format: ExportFormat; scale: number }
export interface DownloadedFile { bytes: Buffer; contentType: string | null }

export interface FigmaClient {
  /** The file's name, when it last changed, and the id of its first page (what a whole-file link renders). */
  getFile(cred: FigmaCredential, fileKey: string): Promise<FigmaFileSummary>;
  /** A node's name, or null when Figma has no such node in the file. */
  getNodeName(cred: FigmaCredential, fileKey: string, nodeId: string): Promise<string | null>;
  getComments(cred: FigmaCredential, fileKey: string): Promise<FigmaComment[]>;
  /** The URL Figma rendered the node at. Throws render_failed when Figma answers null for it. */
  renderNode(cred: FigmaCredential, fileKey: string, nodeId: string, opts: RenderOptions): Promise<string>;
  /** Downloads a render URL (no credential: the URL is pre-signed), refusing more than `maxBytes`. */
  download(url: string, maxBytes: number): Promise<DownloadedFile>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const FIGMA_API_BASE = "https://api.figma.com";
const TIMEOUT_MS = 15_000;

export function authHeaders(cred: FigmaCredential): Record<string, string> {
  return cred.tokenType === "oauth" ? { Authorization: `Bearer ${cred.token}` } : { "X-Figma-Token": cred.token };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function statusToError(res: Response): FigmaApiError {
  const s = res.status;
  if (s === 401 || s === 403) return new FigmaApiError("refused", s);
  if (s === 404) return new FigmaApiError("not_found", s);
  if (s === 429) {
    const header = res.headers.get("retry-after");
    const ra = header === null ? NaN : Number(header);
    return new FigmaApiError("rate_limited", s, Number.isFinite(ra) && ra >= 0 ? ra : undefined);
  }
  if (s === 400) return new FigmaApiError("bad_request", s);
  return new FigmaApiError("unavailable", s);
}

/** A render URL is fetched by the server, so it must be a plain https URL on a named host (never an IP literal or localhost). */
export function isSafeRenderUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return false;
  if (h.startsWith("[") || /^[0-9.]+$/.test(h)) return false; // an IPv6 or IPv4 literal
  return h.includes(".");
}

export function createFigmaClient(fetchImpl: FetchLike = (i, init) => fetch(i, init)): FigmaClient {
  async function getJson(cred: FigmaCredential, path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${FIGMA_API_BASE}${path}`, {
        method: "GET",
        headers: { ...authHeaders(cred), Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new FigmaApiError("unavailable");
    }
    if (!res.ok) throw statusToError(res);
    try {
      return await res.json();
    } catch {
      throw new FigmaApiError("unavailable", res.status);
    }
  }

  return {
    async getFile(cred, fileKey) {
      const body = await getJson(cred, `/v1/files/${encodeURIComponent(fileKey)}?depth=1`);
      if (!isRecord(body) || typeof body.name !== "string" || typeof body.lastModified !== "string") {
        throw new FigmaApiError("unavailable");
      }
      const doc = isRecord(body.document) ? body.document : null;
      const first = doc && Array.isArray(doc.children) && isRecord(doc.children[0]) ? doc.children[0] : null;
      return {
        name: body.name,
        lastModified: body.lastModified,
        firstPageId: first && typeof first.id === "string" ? first.id : null,
      };
    },

    async getNodeName(cred, fileKey, nodeId) {
      const body = await getJson(cred, `/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`);
      if (!isRecord(body) || !isRecord(body.nodes)) throw new FigmaApiError("unavailable");
      const entry = body.nodes[nodeId];
      if (!isRecord(entry) || !isRecord(entry.document)) return null;
      return typeof entry.document.name === "string" ? entry.document.name : null;
    },

    async getComments(cred, fileKey) {
      const body = await getJson(cred, `/v1/files/${encodeURIComponent(fileKey)}/comments`);
      if (!isRecord(body) || !Array.isArray(body.comments)) throw new FigmaApiError("unavailable");
      return body.comments.filter((c): c is FigmaComment => isRecord(c) && typeof c.id === "string");
    },

    async renderNode(cred, fileKey, nodeId, opts) {
      const q = `ids=${encodeURIComponent(nodeId)}&format=${opts.format}&scale=${opts.scale}`;
      const body = await getJson(cred, `/v1/images/${encodeURIComponent(fileKey)}?${q}`);
      if (!isRecord(body) || !isRecord(body.images)) throw new FigmaApiError("unavailable");
      if (typeof body.err === "string" && body.err) throw new FigmaApiError("render_failed");
      const url = body.images[nodeId];
      if (typeof url !== "string" || !url) throw new FigmaApiError("render_failed");
      return url;
    },

    async download(url, maxBytes) {
      if (!isSafeRenderUrl(url)) throw new FigmaApiError("render_failed");
      let res: Response;
      try {
        res = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        throw new FigmaApiError("unavailable");
      }
      if (!res.ok) throw new FigmaApiError("render_failed", res.status);
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) throw new FigmaApiError("too_large");
      if (!res.body) throw new FigmaApiError("render_failed");
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new FigmaApiError("too_large");
          }
          chunks.push(Buffer.from(value));
        }
      } catch (e) {
        if (e instanceof FigmaApiError) throw e;
        throw new FigmaApiError("unavailable");
      }
      if (total === 0) throw new FigmaApiError("render_failed");
      return { bytes: Buffer.concat(chunks), contentType: res.headers.get("content-type") };
    },
  };
}

// ───────────────────────────────────────── injection (tests only) ─────────────────────────────────────────

let override: FigmaClient | null = null;
let live: FigmaClient | null = null;

/** Tests only: every service call goes through this client instead of Figma. Pass null to restore the real one. */
export function setFigmaClientForTests(c: FigmaClient | null): void {
  override = c;
}

/** The client the services use. */
export function figmaClient(): FigmaClient {
  if (override) return override;
  live ??= createFigmaClient();
  return live;
}
