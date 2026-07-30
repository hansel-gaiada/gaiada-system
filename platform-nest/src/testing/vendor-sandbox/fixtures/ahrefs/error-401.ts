// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// Ahrefs error shape — ahrefs.ts's own header confirms ordinary non-2xx HTTP with a
// `{"error": "..."}` JSON body; ahrefs.ts's call() never echoes it (workspace/account-identifying
// detail risk), so the exact wording here is never asserted by any driver test — only the HTTP
// status the driver's `!res.ok` branch reacts to.
export const AHREFS_ERROR_BODY = { error: "sandbox-modeled auth/validation refusal, not vendor-confirmed wording" };
