// PV5-06 — fixtures that put a contract straight into a sent/signed state, the way a real send leaves it.
//
// Since PV5-06 a sent contract carries the SHA-256 of what it says, the stamp of when that was fixed, and its
// signature tier, and the database refuses a sent row without them (`contracts_content_fixed_when_sent`). A fixture
// that inserts `status = 'sent'` directly therefore has to carry the REAL hash of the REAL body, computed here with
// the same function the send route uses. It never sets `pre_pv5_legacy` (only the migration may) and never weakens
// the CHECK. Prefer driving `POST /contracts/:id/send` where the test is not about the table.
import { sha256Hex } from "../core/content-hash";

/** The terms every direct fixture contract carries. */
export const FIXTURE_TERMS = "Terms.";

/** The hash a fixture contract with `FIXTURE_TERMS` was fixed to (and what a portal sign call must echo). */
export const FIXTURE_TERMS_SHA256 = sha256Hex(FIXTURE_TERMS);

/** Columns that make a contract row "sent, content fixed". Spread into an `insert()` row object. */
export function fixedContentCols(bodyMd: string = FIXTURE_TERMS, tier: "attested" | "certified" = "attested") {
  return { body_md: bodyMd, content_sha256: sha256Hex(bodyMd), content_fixed_at: new Date(), signature_tier: tier };
}
