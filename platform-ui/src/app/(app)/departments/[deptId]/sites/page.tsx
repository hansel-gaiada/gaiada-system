import { permanentRedirect } from "next/navigation";

type Params = Promise<{ deptId: string }>;

// RETIRED 2026-09-03 — this was the Web Dev "Operations" tab. It is now a redirect to Portfolio.
//
// ── WHY IT IS GONE, NOT REWRITTEN ──────────────────────────────────────────────────────────────
// It read the SAME endpoint as Portfolio (`console/portfolio`), flattened it with the same helper,
// grouped it by server with a verbatim copy of the same function, and rendered the same filter
// chips. The only thing it added was a health column sourced from `webdev_sites.last_http_status`
// and `last_seen_at` — two columns **no code in this program has ever written** (a repo-wide search
// finds exactly two references: the migration that adds them, and the backend read that returns
// them). So its unique contribution was a column that said "Not checked" on every row forever,
// under a summary line that claimed "0 showing a problem" about an unchecked estate. That is the
// precise failure mode the monitoring program exists to prevent: absence of data rendered as calm.
//
// Health for a site is owned by ONE surface — Business > Monitoring, which actually probes, records
// uptime, opens incidents and watches certificate expiry. A per-department copy of it fed by dead
// columns is worse than no copy.
//
// ── WHY A REDIRECT AND NOT A DELETED DIRECTORY ─────────────────────────────────────────────────
// `sites` was the ORIGINAL path for this department's site surface and is linked from the pipeline,
// the requests queue and (until they are all re-pointed) whatever bookmarks and Linear tickets
// exist. `permanentRedirect` (308) preserves every one of those and tells crawlers/clients the move
// is final, which a `redirect()` (307, "temporary") would not.
//
// `sites/[slug]` — the per-provisioned-site Zone B detail page — is UNAFFECTED: a static segment
// wins over a dynamic sibling in the App Router, so this file only ever catches the bare `sites`
// path. The portfolio's own per-site page is `sites/portfolio/[siteId]`.
export default async function WebDevSitesRedirect({ params }: { params: Params }) {
  const { deptId } = await params;
  permanentRedirect(`/departments/${deptId}/sites/portfolio`);
}
