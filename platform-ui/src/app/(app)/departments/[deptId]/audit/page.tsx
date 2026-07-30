import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import { CostTierBadge } from "@/components/search/CostTierBadge";
import { AuditFindingsPanel } from "@/components/search/AuditFindingsPanel";
import { listProperties, listAudits, listAuditFindings, numberOrDash, type SearchProperty, type SearchAudit } from "@/lib/searchMarketing";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
// Next 15: searchParams is async.
type SearchParams = Promise<{ propertyId?: string; auditId?: string }>;

// Site Audit (SM-08's ingest + triage endpoints, wired up here per SM-12). A crawl itself is
// triggered elsewhere (SM-07's own job/worker, `search-crawl-go`, out of scope for this console) —
// this tab only reads audits `search-crawl-go` (or a future SEONaut/Unlighthouse adapter) has
// already produced and lets a human triage what they found. There is deliberately no "run a new
// audit" button here: `POST audits` INGESTS an already-completed report, it does not dispatch a
// crawl, so a button that implied otherwise would lie about what a click does.
export default async function DepartmentSeoAuditPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const sp = await searchParams;
  const canManage = can(me, "search.manage", tenant);

  // Both degrade to [] on 404/403 (module disabled for this tenant, or a Cerbos denial) so the tab
  // renders its empty state instead of erroring the whole page.
  const properties = await listProperties(userId, tenant);
  const propertyId = sp.propertyId && properties.some((p) => p.id === sp.propertyId) ? sp.propertyId : properties[0]?.id;

  const audits: SearchAudit[] = propertyId ? await listAudits(userId, tenant, propertyId) : [];
  const auditId = sp.auditId && audits.some((a) => a.id === sp.auditId) ? sp.auditId : audits[0]?.id;

  const findings = auditId ? await listAuditFindings(userId, tenant, auditId) : [];
  const selectedAudit = audits.find((a) => a.id === auditId);

  return (
    <>
      <Card title="Site Audit" headerRight={<CostTierBadge tier="free" />}>
        {properties.length === 0 ? (
          <TeachState
            glyph="⚑"
            title="No properties registered"
            body="A property is a client domain this department works on — register one from the Engagements tab before a crawl has anything to audit."
            ctaLabel="Go to Engagements"
            ctaHref={`/departments/${deptId}/engagements`}
          />
        ) : (
          <>
            <form className="lux-filters" method="get" aria-label="Property filter" style={{ marginBottom: 16 }}>
              <label className="lux-filters__field">
                <span>Property</span>
                <select name="propertyId" defaultValue={propertyId}>
                  {properties.map((p: SearchProperty) => (
                    <option key={p.id} value={p.id}>{p.domain}</option>
                  ))}
                </select>
              </label>
              <div className="lux-filters__actions">
                <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">View</button>
              </div>
            </form>

            {audits.length === 0 ? (
              <TeachState
                glyph="⚐"
                title="No audits yet for this property"
                body="Once search-crawl-go (or another adapter) completes a crawl and its report is ingested, the audit and its findings will appear here."
              />
            ) : (
              <HairlineTable
                columns={[
                  { label: "Kind" }, { label: "Source" }, { label: "Status" },
                  { label: "Score", align: "right" }, { label: "Completed" }, { label: "" },
                ]}
                rows={audits.map((a) => [
                  a.kind,
                  a.source,
                  <StatusBadge key="s" label={a.status} />,
                  numberOrDash(a.score),
                  a.completedAt ? new Date(a.completedAt).toLocaleString() : "—",
                  <Link
                    key="l"
                    href={`/departments/${deptId}/audit?propertyId=${propertyId}&auditId=${a.id}`}
                    style={{ font: "600 12px var(--font-body)", color: a.id === auditId ? "var(--erp-accent)" : "var(--text-primary)" }}
                  >
                    {a.id === auditId ? "Viewing" : "View findings"}
                  </Link>,
                ])}
                tcols="1fr 1fr .9fr .7fr 1.3fr 1fr"
              />
            )}
          </>
        )}
      </Card>

      {selectedAudit && (
        <Card
          title={`Findings — ${selectedAudit.kind} audit`}
          headerRight={
            selectedAudit.summary ? (
              <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
                {Object.entries(selectedAudit.summary)
                  .filter(([, count]) => count > 0)
                  .map(([sev, count]) => `${count} ${sev}`)
                  .join(" · ") || "no open findings"}
              </span>
            ) : undefined
          }
        >
          <AuditFindingsPanel tenantId={tenant} findings={findings} canManage={canManage} />
        </Card>
      )}
    </>
  );
}
