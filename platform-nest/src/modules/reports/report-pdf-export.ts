// TR-21 — PDF export via the `report-renderer` sidecar (§6.3, the flow TR-19 built the other
// half of). This is the ONE file in the reports module that mints/burns the one-shot `jobToken`
// and talks to Redis + the sidecar over HTTP — `report-export.ts` stays network/Postgres-free BY
// DESIGN (its own header comment: "this file never touches Postgres or the network"), so PDF's
// network-touching half lives here instead of being folded into that file.
//
// ⚡ THIS IS THE AUTH-BYPASS-BY-CONSTRUCTION SURFACE §12/TR-21 GATES ON. Every requirement below
// is restated at the exact line that enforces it, not only here, but the shape is worth stating
// once, up front:
//
//   1. NO TENANT CREDENTIAL EVER REACHES THE SIDECAR. `renderPdfViaSidecar` sends the sidecar
//      exactly two things: the shared `RENDERER_TOKEN` (its own bearer auth, config-level, never
//      per-user) and a URL containing the one-shot `jobToken`. No session cookie, no OIDC token,
//      no `x-user-id`, no tenant header ever appears in that request. The sidecar's own SSRF
//      guard (report-renderer/src/auth.ts, NOT touched here) additionally pins the URL's origin
//      to `PLATFORM_UI_INTERNAL_URL`, so even a leaked `RENDERER_TOKEN` cannot turn it into an
//      arbitrary-URL fetcher — that guard is TR-19's, verified live there; this file only has to
//      not undermine it by handing the sidecar anything OTHER than that one internal print URL.
//   2. THE PAYLOAD ROUTE IS NOT A GENERAL API. `burnPrintJobToken` is the ONLY function the
//      internal `/internal/reports/print-payload/:jobToken` route (print-payload.controller.ts)
//      calls to resolve its one path param. There is no tenantId, no scopeRef, no grain, no
//      revision on that route for a caller to widen — the token's Redis VALUE *is* the
//      already-authorized, already-built `ReportDocument`, not a document id the route would
//      re-look-up. A token minted for document X therefore cannot be made to yield document Y:
//      there is no second parameter anywhere on the path that names a document.
//   3. MINT AFTER AUTHORIZING, NEVER BEFORE. `mintPrintJobToken` takes the document the CALLER
//      already fetched — `reports.controller.ts`'s `createExport` calls
//      `authorizeReportDocumentRead` and `fetchReportDocumentForRead` first, exactly as it does
//      for xlsx/csv, and only then calls this file. This module has no access to a `Principal` at
//      all (it is deliberately not importable from anywhere that would let it take one), so a
//      token can never represent access the requester didn't have — there is no code path here
//      that could check anything even if it wanted to skip the caller's authz.
//   4. TOKENS ARE UNGUESSABLE AND ENCODE NOTHING. `generateJobToken` is 256 bits of
//      `crypto.randomBytes`, base64url-encoded — no sequence, no timestamp, no document id in any
//      recoverable form. The document identity lives ONLY in the Redis value the token happens to
//      key, never in the token's own bytes.
//   5. BURN IS ATOMIC. `burnPrintJobToken` is Redis `GETDEL` (v6.2+), a single atomic
//      get-and-delete: a replay of the exact same token after a first successful read, an
//      already-expired token, and a token that never existed all collapse to the identical `null`
//      result — there is no window in which two concurrent callers could both observe "valid".
//
// ─────────────────────────────── STORAGE CHOICE (ticket's explicit instruction) ────────────────
// The ticket says: "if you need durable token storage and believe a migration is required, STOP
// and report why rather than writing one." No migration is needed and none is written. A
// `jobToken` is intentionally SHORT-LIVED PROCESS STATE, not a durable record of anything — if it
// expires unused, nothing is lost except an in-flight PDF render that the caller can simply retry
// (a fresh `POST .../export` mints a fresh token). This reuses the SAME shared ioredis client
// every other event-backbone component in this codebase already uses
// (`../../events/redis`'s `getRedis`/`setRedis` — see `relay.test.ts`'s `setRedis(new
// Redis(REDIS_TEST_URL))` for the exact test convention this file's own db test follows) rather
// than opening a second Redis connection or inventing a second ephemeral-state mechanism.
//
// `originSite: config.originSite` is stamped on every stored value even though Redis carries no
// RLS/tenant partitioning of its own and this state is never read back by anything except
// `burnPrintJobToken` (never queried, never reported on, never synced) — every other row this
// program writes tags its origin site (§15's `origin_site` ruling), and doing the same here costs
// nothing and keeps a token traceable in an operator's Redis dump if one is ever needed. It is
// recorded for that reason ALONE: this is explicitly NOT durable data, and nothing about the
// multi-site sync engine (`sync-engine-go/`) ever touches it — it lives and dies in Redis, never
// in `outbox_events`.
import { randomBytes } from "node:crypto";
import { getRedis } from "../../events/redis";
import { config } from "../../config";
import type { ReportDocument, ReportGrain } from "./report-document";

/** §6.3: "one-shot, 5-min-TTL jobToken". */
export const PRINT_JOB_TOKEN_TTL_SECONDS = 5 * 60;

// Exported so a test can force-expire a minted token via the REAL Redis TTL mechanism
// (`getRedis().pexpire(printJobRedisKey(token), 1)`) rather than reimplementing/mocking expiry.
export const PRINT_JOB_REDIS_KEY_PREFIX = "reports:printjob:";

export function printJobRedisKey(token: string): string {
  return `${PRINT_JOB_REDIS_KEY_PREFIX}${token}`;
}

/** The one-shot token's Redis value: the FULLY resolved, ALREADY-authorized document, not an id
 *  the payload route would look up again. `sealHash` travels alongside `document` (it is not part
 *  of `ReportDocument` itself — `report_periods.seal_hash` — see report-export.ts's identical
 *  need) so the printed page/PDF can carry the same `SEALED · rev N · <hash>` provenance the
 *  xlsx/csv exports do. */
export interface PrintJobPayload {
  tenantId: string;
  grain: ReportGrain;
  scopeRef: string;
  document: ReportDocument;
  sealHash?: string;
  originSite: string;
  mintedAt: string;
}

export type MintPrintJobInput = Omit<PrintJobPayload, "originSite" | "mintedAt">;

/** Crypto-random, unguessable (requirement 4). 256 bits from `randomBytes(32)`, base64url so it
 *  drops into a URL path segment (`/print/reports/:jobToken`) with no further escaping needed —
 *  it contains only `[A-Za-z0-9_-]`. Encodes nothing about the document: the document identity
 *  lives solely in the Redis value this token happens to key. */
export function generateJobToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Mint a one-shot token bound to ONE already-authorized, already-built document.
 *
 *  CALLERS MUST have already run `authorizeReportDocumentRead` (or equivalent) for the requesting
 *  principal, and already fetched the exact `ReportDocument` being minted, BEFORE calling this —
 *  this function takes no `Principal` and does no authorization of its own (requirement 3: mint
 *  AFTER authorizing, never before — there is structurally nothing here that could check
 *  anything even if it tried). Returns the token; the caller embeds it in the sidecar's `url`
 *  (`{PLATFORM_UI_INTERNAL_URL}/print/reports/{jobToken}`). */
export async function mintPrintJobToken(input: MintPrintJobInput): Promise<string> {
  const token = generateJobToken();
  const record: PrintJobPayload = { ...input, originSite: config.originSite, mintedAt: new Date().toISOString() };
  await getRedis().set(printJobRedisKey(token), JSON.stringify(record), "EX", PRINT_JOB_TOKEN_TTL_SECONDS);
  return token;
}

/** Validate-and-BURN in one atomic step (`GETDEL`, requirement 5). A token that never existed,
 *  already expired past its 5-minute TTL, or was already consumed by an earlier call all return
 *  `null` — identically, with no signal that would let a caller distinguish "wrong token" from
 *  "right token, already used" (this ticket's acceptance bar: replay -> 401, expiry -> 401, both
 *  a uniform refusal, never a partial document).
 *
 *  This is the ONLY function `print-payload.controller.ts` calls to resolve its path param. It
 *  never re-checks Cerbos and never re-authorizes anything, BECAUSE the payload it returns was
 *  already authorized once, at mint time, for the principal who created the export — there is no
 *  principal on the payload route to re-check against, by design (requirement 2). */
export async function burnPrintJobToken(token: string): Promise<PrintJobPayload | null> {
  if (!token) return null;
  const raw = await getRedis().getdel(printJobRedisKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PrintJobPayload;
  } catch {
    // Should never happen (only mintPrintJobToken ever writes this key) — fail closed rather
    // than let a corrupt value reach the caller as a crash.
    return null;
  }
}

// ═══════════════════════════════ the sidecar HTTP round trip ═══════════════════════════════

export class PdfRendererNotConfiguredError extends Error {}
export class PdfRenderFailedError extends Error {}

export interface RenderPdfViaSidecarOptions {
  rendererUrl: string;
  rendererToken: string;
  platformUiInternalUrl: string;
  timeoutMs?: number;
}

/** `POST {rendererUrl}/render {url}` + `Authorization: Bearer {rendererToken}` (§6.3, TR-19's own
 *  contract). `url` is built from `platformUiInternalUrl` + the one-shot `jobToken` path — the
 *  ONLY thing this function ever sends the sidecar besides the shared bearer token (requirement
 *  1: no tenant credential, no session, no per-user identity in this call at all). Same
 *  fetch-with-AbortController-timeout idiom `admin-systems.controller.ts` already uses for every
 *  other downstream-service probe in this codebase. */
export async function renderPdfViaSidecar(jobToken: string, opts: RenderPdfViaSidecarOptions): Promise<Buffer> {
  if (!opts.rendererUrl || !opts.rendererToken || !opts.platformUiInternalUrl) {
    throw new PdfRendererNotConfiguredError(
      "report-renderer is not configured (REPORT_RENDERER_URL / RENDERER_TOKEN / PLATFORM_UI_INTERNAL_URL)",
    );
  }
  const printUrl = `${opts.platformUiInternalUrl.replace(/\/$/, "")}/print/reports/${jobToken}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30000);
  try {
    const res = await fetch(`${opts.rendererUrl.replace(/\/$/, "")}/render`, {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.rendererToken}` },
      body: JSON.stringify({ url: printUrl }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new PdfRenderFailedError(`report-renderer responded ${res.status}${body ? `: ${body}` : ""}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}
