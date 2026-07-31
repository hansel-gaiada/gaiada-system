import "server-only";
// TR-20 — the print route's ONLY data source. §6.3's flow: platform-nest mints a one-shot,
// 5-minute-TTL, single-document `jobToken`, hands the sidecar `PLATFORM_UI_INTERNAL_URL +
// /print/reports/{jobToken}`, and THIS module is what the print route calls when that URL is hit —
// a session-less server-to-server fetch of `GET /internal/reports/print-payload/:jobToken` on
// platform-nest, which validates and BURNS the token on that one read. No cookie, no `x-user-id`,
// no `PLATFORM_SERVICE_TOKEN` — the jobToken IS the entire authorization for this call, which is
// exactly why the route this feeds "renders nothing without a valid one-shot token" (§6.3).
//
// Deliberately NOT `platformFetch` (lib/platform.ts): that helper resolves a browser session
// (OIDC/dev bearer + x-user-id) and DEMO_MODE from a request's cookie jar — none of which exist
// here. The sidecar that calls this route has no cookies at all (§6.3's whole point), so reusing
// platformFetch would either silently attach the wrong identity or throw reaching for a session
// that was never there.
//
// ⚠ CONTRACT NOTE (scope boundary): the endpoint this module calls — `/internal/reports/print-
// payload/:jobToken` — is TR-21's (senior-be, platform-nest). It landed concurrently with this
// ticket (a parallel session's `print-payload.controller.ts` + `report-pdf-export.ts` — this file
// does not touch or depend on that work having built successfully, per this ticket's platform-nest
// boundary). Confirmed by reading that source directly: the response body is exactly
// `{ document: ReportDocument, sealHash: string | null }`, and EVERY refusal case (token never
// existed, expired past its 5-min TTL, or already burned by an earlier read — `burnPrintJobToken`
// is a Redis `GETDEL`, so all three collapse to the same `null`) answers a uniform `401`, never a
// distinguishing status. This module's `not_found`/`expired`/404/410 branches below are therefore
// broader than what the real backend will ever actually send (only 401 fires in practice) —
// deliberately kept as defensive handling rather than narrowed to exactly-401, since the print
// route treats every `PrintTokenError` identically regardless of `.reason` (see the page's own
// catch block) and a slightly-different future error shape costs nothing to already tolerate.
// `PRINT_STUB` (below) is a clearly-marked local test fixture for exercising this route's
// rendering without depending on a live platform-nest/Redis instance — it is NOT part of the real
// contract and is never reached unless explicitly opted into.
import type { ReportDocument } from "./reports";

/** The shape TR-21's endpoint is expected to answer with: the already-authorized `ReportDocument`
 *  plus — only when `document.header.sealed` — the `report_periods.seal_hash` the caller looked up
 *  (report-export.ts's own precedent: the hash is NOT part of `ReportDocument` itself). */
export interface PrintPayload {
  document: ReportDocument;
  sealHash?: string;
}

export type PrintTokenReason =
  | "missing"       // no jobToken in the URL at all
  | "not_found"     // platform-nest has no such token (never minted, or already burned)
  | "expired"       // past the 5-minute TTL
  | "malformed"      // platform-nest answered 200 with a body that isn't a usable PrintPayload
  | "upstream_error"; // network failure, non-2xx/non-404 status, or PLATFORM_URL unset

export class PrintTokenError extends Error {
  constructor(public reason: PrintTokenReason, message: string) {
    super(message);
    this.name = "PrintTokenError";
  }
}

function isReportDocumentShaped(v: unknown): v is ReportDocument {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return !!d.header && Array.isArray(d.kpis) && Array.isArray(d.series) && Array.isArray(d.distributions) && Array.isArray(d.tables);
}

/** THE read. Every failure mode collapses to a `PrintTokenError` with a `reason` — the print route
 *  never has to distinguish "token" errors from "network" errors to decide what to render: any of
 *  them means the same thing to a viewer of the PDF ("this link can't be rendered"), which is the
 *  honest, undifferentiated refusal §6.3 asks for. `reason` is kept for server-side logging only. */
export async function getPrintPayload(jobToken: string): Promise<PrintPayload> {
  if (!jobToken || !jobToken.trim()) {
    throw new PrintTokenError("missing", "no jobToken supplied");
  }

  // TR-40 (architect hardening): the stub check sits BEFORE the real fetch, so a stray PRINT_STUB=1
  // in a deployed environment would render FABRICATED numbers into a real, printed, executive-facing
  // PDF — strictly worse than an error, because a wrong report that looks right gets circulated and
  // acted on. Belt-and-braces: the fixture is additionally inert unless NODE_ENV is non-production,
  // so enabling it in prod fails loudly (an undifferentiated refusal) instead of silently lying.
  if (process.env.PRINT_STUB === "1") {
    if (process.env.NODE_ENV === "production") {
      throw new PrintTokenError(
        "upstream_error",
        "PRINT_STUB is a dev-only fixture and is refused in production — unset it",
      );
    }
    const { getStubPrintPayload } = await import("./reports-print-stub");
    return getStubPrintPayload(jobToken);
  }

  const base = process.env.PLATFORM_URL;
  if (!base) {
    throw new PrintTokenError("upstream_error", "PLATFORM_URL is not configured");
  }

  let res: Response;
  try {
    res = await fetch(`${base}/internal/reports/print-payload/${encodeURIComponent(jobToken)}`, {
      method: "GET",
      cache: "no-store",
    });
  } catch {
    throw new PrintTokenError("upstream_error", "could not reach platform-nest");
  }

  if (res.status === 404 || res.status === 401 || res.status === 410) {
    // The exact status TR-21 will use for "burned"/"expired" isn't settled yet (not built) — a
    // one-shot-token endpoint conventionally answers any of these for "this token no longer
    // resolves to anything", and this route treats them identically (see the honest-refusal note
    // above), so guessing wrong between them costs nothing.
    throw new PrintTokenError(res.status === 410 ? "expired" : "not_found", `print payload rejected: ${res.status}`);
  }
  if (!res.ok) {
    throw new PrintTokenError("upstream_error", `print payload fetch failed: ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new PrintTokenError("malformed", "print payload response was not valid JSON");
  }
  const payload = body as Partial<PrintPayload> | null;
  if (!payload || !isReportDocumentShaped(payload.document)) {
    throw new PrintTokenError("malformed", "print payload response did not contain a usable ReportDocument");
  }
  return { document: payload.document, sealHash: typeof payload.sealHash === "string" ? payload.sealHash : undefined };
}
