// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// DataForSEO TOP-LEVEL error envelope (SM-49 AC 7 / AC 11): status_code sits in the 40000+ range
// dataforseo.ts's assertOk() checks BEFORE ever looking at `.tasks` — used both for a genuine
// vendor-error-inside-200 case (missing funds / auth-shaped refusal) and for the "missing required
// parameter" strictness case (AC 11), which reuses the identical shape with a different message —
// DataForSEO's own documented convention has no separate envelope for the two.
export function envelopeErrorBody(message: string) {
  return {
    status_code: 40401,
    status_message: message,
  };
}
