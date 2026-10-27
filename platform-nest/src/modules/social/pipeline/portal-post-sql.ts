// SCP-2 — the post-row half of the portal's visibility rule, in a leaf file (no imports) so the portal's Ball
// (`modules/clients/client-ball.ts`) and the approval page's reads (`portal-read.ts`) state it once.
//
// A pipeline post is visible to a portal contact when it is not deleted, not archived, is a pipeline post, and has reached the client
// at least once (`client_first_sent_at`). The other half, that it belongs to one of the caller's clients, is the engagement's
// (`portal-read.ts` `portalPostVisibleSql`) or, on a review row, the review's own `client_id`.

/** The conditions on the post row `p` alone. */
export function portalPostRowVisibleSql(p: string): string {
  return `${p}.deleted_at IS NULL AND ${p}.archived_at IS NULL AND ${p}.pipeline_status IS NOT NULL AND ${p}.client_first_sent_at IS NOT NULL`;
}
