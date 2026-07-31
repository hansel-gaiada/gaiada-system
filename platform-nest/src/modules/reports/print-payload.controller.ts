// TR-21 — `GET /internal/reports/print-payload/:jobToken` (§6.3's browser-less document fetch).
//
// Deliberately NOT under `api/:tenantId/...`, NOT behind `AuthGuard`/`ServiceGuard`, NOT gated by
// `ModuleEnabledGuard` — the print route this backs (TR-20, `platform-ui/src/app/print/reports/
// [jobToken]/`) runs inside the sidecar's headless Chromium page (`report-renderer`, TR-19),
// which never holds a session cookie, a tenant header, or an OIDC token. The ONLY thing standing
// between this handler and the rest of the platform is the one-shot `jobToken` itself. This is
// the app-level, no-`/api`-prefix route shape §6.3 calls out as following the repo's existing
// precedent for a root, unauthenticated-by-session route:
// `src/identity/identity.controller.ts`'s bare `@Controller()` (`principal/resolve`,
// `admin/users/:userId/revoke`, etc.) — same idiom, registered the same way in `app.module.ts`.
//
// ─────────────────────────────── WHY THIS IS NOT A GENERAL API (⚡ this ticket's core requirement,
// restated here where it is actually enforced, not only in the ticket text) ─────────────────────
//   - There is no `tenantId` route param and no identity header read anywhere in this file. The
//     ONLY input to this handler is the token in the path — there is nothing for a caller to
//     widen, because there is no scope/grain/tenant/revision parameter here to widen.
//   - `burnPrintJobToken` (report-pdf-export.ts) is the ONLY thing this handler calls to resolve
//     `:jobToken`. It is a Redis `GETDEL`: a token that never existed, one that already expired
//     past its 5-minute TTL, and one that was already consumed by an earlier call all resolve to
//     the exact same `null` — this handler cannot tell them apart, and neither can a caller
//     probing it (uniform 401, never a signal that a token "used to be valid").
//   - The document this handler returns was fully authorized and fully built BEFORE the token
//     even existed — `reports.controller.ts`'s `createExport` calls
//     `authorizeReportDocumentRead` (the SAME Cerbos check a live document read runs), THEN
//     `fetchReportDocumentForRead`, THEN `mintPrintJobToken`. This handler never re-derives,
//     never re-fetches, never re-authorizes anything; it can only hand back the exact payload it
//     was given, exactly once, to whoever holds the one URL the sidecar was told to fetch.
import { Controller, Get, HttpCode, Param, UnauthorizedException } from "@nestjs/common";
import { burnPrintJobToken } from "./report-pdf-export";

@Controller("internal/reports/print-payload")
export class PrintPayloadController {
  @Get(":jobToken")
  @HttpCode(200)
  async getPrintPayload(@Param("jobToken") jobToken: string) {
    const payload = await burnPrintJobToken(jobToken);
    if (!payload) {
      // Uniform refusal for missing / expired / already-burned (this ticket's acceptance bar:
      // replay -> 401, expiry -> 401) — never a partial document, never a distinguishing signal.
      throw new UnauthorizedException("invalid or expired print job token");
    }
    // The shape TR-20's print route renders with the SAME `ReportViewer` the live app uses
    // (`document: ReportDocument`, per platform-ui/src/components/reports/ReportViewer.tsx),
    // plus `sealHash` — not part of `ReportDocument` itself (see report-export.ts's identical
    // need) — so the printed page can show the exact `SEALED · rev N · <hash>` / `AD HOC ·
    // UNSEALED` provenance the xlsx/csv exports carry (this ticket's provenance-parity bar).
    return { document: payload.document, sealHash: payload.sealHash ?? null };
  }
}
