// PRV-02 — the ONE slug derivation (design §04 / D-P8).
//
// ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────────────────────────────
// The shipped delivery workflow (`automation/workflows/pipeline-delivery.json`, node "Load + decide")
// already derives a slug from the run title and hands it to `github.repoStatus(repo: slug)` on the
// `release_code` beat. The whole cheap win of this seam is that once `provision` has run, that gate
// passes with ZERO workflow changes — which is true only while the two derivations agree BYTE FOR
// BYTE. Two independent copies of a string transform do not stay equal; they drift on the first
// "small improvement" (trim both ends properly, collapse repeats, slugify unicode) and the failure is
// silent: the repo exists, the gate says it does not, and the run parks forever.
//
// So: one function, and `slug-parity.test.ts` re-extracts the workflow's own expression from the JSON
// and executes it against the same inputs. That test asserts equality against the WORKFLOW STRING,
// not against a second hand-copy of it — a hand-copied expectation would go stale in exactly the same
// way the code it guards would.
//
// ── THE TRANSFORM, AND ITS DELIBERATE ODDITIES (do NOT "fix" these) ───────────────────────────────
// The workflow expression is:
//   String(run.title||('run-'+run.id)).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)
// Three things about it look like bugs and are not — they are the CONTRACT:
//   1. `.replace(/^-|-$/g,'')` strips ONE leading and ONE trailing hyphen, not runs of them. A title
//      like "-- Acme --" keeps an inner hyphen at each end. Changing this to `/^-+|-+$/g` would be a
//      strictly nicer slug and an immediate parity break.
//   2. The trim happens BEFORE `.slice(0,40)`, so a 41-character run can still end in a hyphen. That
//      is fine for both consumers: provision's own grammar is `^[a-z0-9-]+$` (provisionProject.ts:261)
//      and this table's CHECK is `^[a-z0-9-]{1,40}$` — a trailing hyphen is legal in both.
//   3. The fallback is `run-<uuid>`, i.e. 4 + 36 = 40 characters exactly. It fits the cap by one
//      character, which is luck, not design; it is asserted in the parity test so a future cap change
//      cannot silently start truncating the fallback into a colliding prefix.
//
// The result can still be EMPTY (a title of only punctuation collapses to "-" then to ""). That is a
// caller-visible 422 `invalid_slug`, not something to paper over with a fallback here: silently
// substituting `run-<id>` for a title the user chose would provision a repo under a name nobody
// recognizes, and the caller can supply an explicit `slug` override instead.

/** Provision's own name grammar (`provisionProject.ts:261`, a DNS/GoDaddy constraint) intersected
 *  with this table's 40-char cap (`0090_webdev_provisioned_sites.sql`'s `slug` CHECK).
 *
 *  Re-validated ERP-side BEFORE egress even though provision validates it too — defense in depth for
 *  provision's `/bin/sh -c` heredoc (`provisionProject.ts:155`), which is safe ONLY under this
 *  grammar. This is the design's binding constraint §01(2), not a nicety. */
export const PROVISION_SLUG_RE = /^[a-z0-9-]{1,40}$/;

/** Derive a provision project name from a pipeline run, byte-identically to the delivery workflow's
 *  "Load + decide" expression. See this file's header for why every oddity is preserved.
 *
 *  `title` is the run's `title` column (nullable); `runId` backs the `run-<id>` fallback. */
export function deriveRunSlug(title: string | null | undefined, runId: string): string {
  return String(title || `run-${runId}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** True when `slug` is safe to send to provision AND storable in `webdev_provisioned_sites.slug`.
 *  A `false` here is a 422 `invalid_slug`, never a silent substitution. */
export function isValidProvisionSlug(slug: string): boolean {
  return PROVISION_SLUG_RE.test(slug);
}
