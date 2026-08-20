// SMM-36 — per-network inbox retention policy: WHAT maximum-retention window (if any) is
// DOCUMENTED for each network's own data-storage rules, split by data class the way
// `publisher/capabilities.ts` splits a capability's `false` into "network"/"driver"/"unverified"
// reasons. Read that file's header first — the reasoning is identical: collapsing distinct kinds of
// "we don't know" into one signal destroys the only thing an operator needs, and the same failure
// mode applies here to "there is no cap" vs "nobody has checked".
//
// ── THE ONLY HARD NUMBERS THIS TICKET HAS ──────────────────────────────────────────────────────
// LinkedIn's Data Storage Requirements (addendum §A4e item 1, OQ-1's first research return) are the
// SOLE documented ceiling across all four OQ-1 legs:
//   - another member's PROFILE data (name, handle, avatar)         — 24 hours
//   - a member's own social-ACTIVITY content (comment/DM text)     — 48 hours
// Checked at LinkedIn's Standard Tier review and demonstrated at Technical Sign Off — this is not a
// number we chose, it is a number we were told and must be able to prove we honour.
//
// Every other network 0105/`capabilities.ts` admits was researched for OTHER things
// (Meta §A4f: posting limits + media rules; YouTube §A4g: the private-upload lock + quota; TikTok
// §A4h: the audit lock + consent timing) and NONE of those three legs returned a retention ceiling.
// Inventing one for them would be exactly the "confident wrong answer" failure class the root guide
// warns about — so they are `unverified` here, a NAMED gap, never a guessed number and never
// silently treated as "no limit".
//
// ── WHY "UNVERIFIED" MEANS "DO NOT TOUCH IT", THE OPPOSITE OF capabilities.ts's FAIL-CLOSED ──────
// `capabilities.ts` fails closed by turning an unverified capability into `false` (denying an
// affordance we cannot prove we have). The safe direction here is the mirror image: a maximum
// retention rule LIMITS how long we may keep data, so "we don't know the limit" must not become
// license to purge on a guessed number — that could destroy data we were fully entitled to keep.
// The purge job (`inbox-retention-job.ts`) therefore only acts on a network whose policy is
// `evidence: 'documented'`; every unverified network is left alone until real research returns a
// number, at which point this file gets ONE new row, not a redesign.
import { KNOWN_NETWORKS } from "./publisher/capabilities";

export type RetentionEvidence = "documented" | "unverified";

export interface NetworkRetentionPolicy {
  /** Max hours another member's profile data (name, handle, avatar) may be retained after we first
   *  stored it. `null` when `evidence !== 'documented'` — never a guessed number. */
  profileDataMaxHours: number | null;
  /** Max hours a member's own social-activity content (comment/DM text) may be retained after we
   *  first stored it. `null` when `evidence !== 'documented'` — never a guessed number. */
  activityContentMaxHours: number | null;
  evidence: RetentionEvidence;
  /** Where the number — or its documented absence — came from. Never omitted: an evidence claim
   *  with no citation is indistinguishable from a guess. */
  citation: string;
}

function unverified(citation: string): NetworkRetentionPolicy {
  return { profileDataMaxHours: null, activityContentMaxHours: null, evidence: "unverified", citation };
}

/** One row per network `capabilities.ts`'s `NETWORK_CAPABILITIES` models (and 0105's CHECK admits).
 *  Sources are cited per row so a future reader can re-verify rather than trust a comment forever. */
const NETWORK_RETENTION: Record<string, NetworkRetentionPolicy> = {
  linkedin: {
    profileDataMaxHours: 24,
    activityContentMaxHours: 48,
    evidence: "documented",
    citation:
      "addendum §A4e item 1 (LinkedIn Data Storage Requirements) — 'another member's profile data' "
      + "24h, 'a member's social activity' (comment text, posts, likes, mentions) 48h; the shorter "
      + "rule applies where two overlap. Checked at Standard Tier review, demonstrated at Technical "
      + "Sign Off.",
  },
  instagram: unverified(
    "Meta OQ-1 leg (addendum §A4f) covered Content Publishing limits and media-format rules; no "
    + "data-retention ceiling was returned by that research.",
  ),
  facebook: unverified(
    "Meta OQ-1 leg (addendum §A4f) covered Content Publishing limits and media-format rules; no "
    + "data-retention ceiling was returned by that research.",
  ),
  tiktok: unverified(
    "TikTok OQ-1 leg (addendum §A4h) covered the SELF_ONLY audit lock and the OQ-8 consent-timing "
    + "question; no data-retention ceiling was returned by that research.",
  ),
  youtube: unverified(
    "YouTube OQ-1 leg (addendum §A4g) covered the private-upload compliance-audit lock and the "
    + "three-bucket quota model; no data-retention ceiling was returned by that research.",
  ),
  x: unverified(
    "Not part of OQ-1's research scope. X is also the sole metered network and ships disabled in "
    + "every deployment regardless (D-14/OQ-2), so this row is inert until both change.",
  ),
  threads: unverified(
    "0105's CHECK constraint admits this network but OQ-1 covered only five networks — this one was "
    + "never researched at all (capabilities.ts's own `unresearched()` marks the same gap).",
  ),
  pinterest: unverified(
    "0105's CHECK constraint admits this network but OQ-1 covered only five networks — this one was "
    + "never researched at all (capabilities.ts's own `unresearched()` marks the same gap).",
  ),
  bluesky: unverified(
    "0105's CHECK constraint admits this network but OQ-1 covered only five networks — this one was "
    + "never researched at all (capabilities.ts's own `unresearched()` marks the same gap).",
  ),
  mastodon: unverified(
    "0105's CHECK constraint admits this network but OQ-1 covered only five networks — this one was "
    + "never researched at all (capabilities.ts's own `unresearched()` marks the same gap).",
  ),
};

/** Every network 0105's CHECK constraint admits, re-exported so a caller never has to import both
 *  this file and `capabilities.ts` to learn the same fleet twice. */
export { KNOWN_NETWORKS };

/** Resolve one network's policy. An unmodelled network (should be impossible — 0105's CHECK and
 *  `KNOWN_NETWORKS` agree on the fleet) fails exactly like `capabilities.ts`'s unmodelled branch:
 *  unverified, never a guess, and named so the gap is visible rather than silent. */
export function getRetentionPolicy(network: string): NetworkRetentionPolicy {
  return (
    NETWORK_RETENTION[network]
    ?? unverified(`network '${network}' is not in the modeled fleet (KNOWN_NETWORKS) at all`)
  );
}

/** Whether the purge job may act on this network at all. `false` for anything `unverified` — see
 *  the header for why "we don't know the cap" must never become "so purge on a guess". */
export function hasDocumentedRetentionCap(network: string): boolean {
  const policy = getRetentionPolicy(network);
  return (
    policy.evidence === "documented"
    && (policy.profileDataMaxHours !== null || policy.activityContentMaxHours !== null)
  );
}
