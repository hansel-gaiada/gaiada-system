import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listAppraisals, getAppraisal, isForbidden } from "@/lib/appraisals-data";
import { PageHeader } from "@/components/PageHeader";
import { ReportAccessDenied } from "@/components/reports/ReportAccessDenied";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card, StatusBadge } from "@/components/ui";
// TR-44: required for `.rc-appr-stale-badge` below. This page renders no component that imports
// appraisals.css (unlike the cycles pages and the detail-page components), so without this import the
// badge silently falls back to unstyled text — which is precisely the defect TR-44 fixes.
import "@/components/reports/appraisals/appraisals.css";

// TR-26 — "Team Appraisals": the manager/HR console listing appraisals this caller may read or
// score (§8's matrix — narrowed server-side; this page renders whatever the BFF actually returns).
// `GET /appraisals` returns a thin list projection with no names, so this hydrates each row via
// `GET /appraisals/:id` to show subject/manager names and the composite — acceptable at console
// scale (bounded by how many appraisals exist for this caller), and it means this page and the
// single-appraisal page never disagree about what a row's numbers are (same read, same hydration).
export default async function AppraisalsConsolePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title="Team Appraisals" />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const canSeeConsole = can(me, "appraisal.score", tenant) || can(me, "appraisal.read", tenant) || can(me, "appraisal.cycle.admin", tenant);
  if (!canSeeConsole) {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title="Team Appraisals" />
        <ReportAccessDenied reason="Team Appraisals is for managers scoring their own reports and for HR/exec — your own appraisal is always at /appraisals/mine." />
      </>
    );
  }

  try {
    const { appraisals: entries } = await listAppraisals(tenant, userId);
    const packs = await Promise.all(entries.map((e) => getAppraisal(tenant, userId, e.id)));
    const drafts = packs.filter((p) => p.status === "draft");
    const rest = packs.filter((p) => p.status !== "draft");

    return (
      <>
        <PageHeader
          eyebrow="Appraisals"
          title="Team Appraisals"
          subtitle="Appraisals you're assigned to score, or — for HR/exec — every appraisal in this company."
          actions={can(me, "appraisal.cycle.admin", tenant) ? <Link href="/appraisals/cycles" className="lux-btn lux-btn--ghost lux-btn--sm">Manage cycles</Link> : undefined}
        />
        {packs.length === 0 ? (
          <EmptyNote>No appraisals here yet — generate a cycle from the HR console.</EmptyNote>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {drafts.length > 0 && (
              <Card title="Awaiting your score">
                <RowList packs={drafts} />
              </Card>
            )}
            {rest.length > 0 && (
              <Card title="Submitted">
                <RowList packs={rest} />
              </Card>
            )}
          </div>
        )}
      </>
    );
  } catch (e) {
    if (isForbidden(e)) {
      return (
        <>
          <PageHeader eyebrow="Appraisals" title="Team Appraisals" />
          <ReportAccessDenied reason="Team Appraisals is for managers scoring their own reports and for HR/exec." />
        </>
      );
    }
    throw e;
  }
}

function RowList({ packs }: { packs: Awaited<ReturnType<typeof getAppraisal>>[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {packs.map((p) => (
        <Link
          key={p.id} href={`/appraisals/${p.id}`}
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 0", borderBottom: "0.5px solid var(--erp-hairline)", textDecoration: "none", color: "inherit" }}
        >
          <span style={{ font: "400 14px var(--font-body)" }}>{p.subjectName}</span>
          <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>{p.cycleName}</span>
          <StatusBadge label={p.status} />
          {/* TR-44: this was bare 10px accent-coloured text, which read as unremarkable grey next to the
              StatusBadge pill beside it and was easy to miss when scanning rows (found by TR-29's visual
              pass). `evidence_stale` means finalize is BLOCKED, so a reader skimming this list must be able
              to see it without opening the row. Rendered as a real badge on the SAME `--rc-serious` signal
              the detail page's banner uses, so both surfaces speak with one voice, and carrying an
              accessible title since the badge text alone doesn't say what the consequence is. */}
          {p.evidenceStale && (
            <span className="rc-appr-stale-badge" title="Evidence changed since this appraisal was generated — it cannot be finalized until re-confirmed.">
              EVIDENCE STALE
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}
