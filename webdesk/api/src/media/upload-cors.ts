// WSK-43a — the CORS rule of the public upload route (`POST|OPTIONS /v1/t/:tenantSlug/media/upload/:token`).
//
// WHO CALLS IT. The upload is made by the ERP's Website editor, in the editor's browser, straight to WebDesk
// (the bytes never traverse Zone A). The page's origin is the ERP's (https://erp.gaiada.online, later
// https://erp.gaiada.com), not the tenant site's, so the draft-preview rule (the token's SITE domains) is the
// wrong one here and is not used. The allowed origins are configuration:
//
//   WEBDESK_UPLOAD_CORS_ORIGINS   a comma-separated list of exact origins, each `https://host[:port]`.
//
// Unset or empty means no CORS headers at all (a server-side caller needs none, and no browser page may read
// an answer). Each entry must be an origin and nothing else: https, a host, an optional port; no path, no
// trailing slash, no wildcard, not `null`. The host is lower-cased (that is what a browser sends). An entry
// that is not that refuses to boot (MediaUploadService.onModuleInit), naming the variable: a CORS list that
// silently drops or widens an entry is worse than an api that does not start.
//
// The route echoes `Access-Control-Allow-Origin` ONLY when the request's Origin equals one configured origin
// exactly (host compared lower-cased). It never sends `Allow-Credentials`, and always sends `Vary: Origin`.

const ORIGIN_RE = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::([0-9]{1,5}))?$/;

export const UPLOAD_CORS_ENV = "WEBDESK_UPLOAD_CORS_ORIGINS";

export class UploadCorsConfigError extends Error {
  constructor(message: string) {
    super(`[webdesk:api] ${UPLOAD_CORS_ENV} ${message}`);
    this.name = "UploadCorsConfigError";
  }
}

/** The normalised origin of one entry, or null when it is not a bare `https://host[:port]`. */
function normaliseOrigin(entry: string): string | null {
  const m = ORIGIN_RE.exec(entry.toLowerCase());
  if (!m) return null;
  if (m[2] !== undefined) {
    const port = Number(m[2]);
    if (port < 1 || port > 65535 || m[2] !== String(port)) return null; // no leading zeros, in range
  }
  return `https://${m[1]}${m[2] !== undefined ? `:${m[2]}` : ""}`;
}

/** The configured origins (deduplicated, normalised). [] when unset or empty. Throws UploadCorsConfigError on a malformed entry. */
export function uploadCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env[UPLOAD_CORS_ENV] ?? "").trim();
  if (raw === "") return [];
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const entry = piece.trim();
    const origin = normaliseOrigin(entry);
    if (origin === null) {
      throw new UploadCorsConfigError(
        `entry ${JSON.stringify(entry)} is not allowed: each entry must be an exact origin, https://host[:port] (no path, no trailing slash, no wildcard, not null). Refusing to boot.`,
      );
    }
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** The Origin to echo for this request, or null (no CORS headers): exactly one configured origin, nothing else. */
export function allowedUploadOrigin(requestOrigin: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!requestOrigin) return null;
  const wanted = requestOrigin.toLowerCase();
  return uploadCorsOrigins(env).find((o) => o === wanted) ?? null;
}
