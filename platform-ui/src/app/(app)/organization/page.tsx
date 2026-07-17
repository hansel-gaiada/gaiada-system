import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { isElevated } from "@/components/shell/nav";
import { getHolding, type CompanyOrg } from "@/lib/organization";
import { PlatformError } from "@/lib/platform";
import { PageHeader } from "@/components/PageHeader";
import { Card, KpiTile, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import "@/components/org/org.css";

// Holding-level organization overview. Reads the computed holding (companies
// grouped under the holding root + per-company org counts) and renders a
// read-only holding→company chart plus a company grid that drills into each
// company's editable org builder. No new backend contract — see lib/organization.
export default async function OrganizationPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const elevated = isElevated(me);

  let holding;
  try {
    holding = await getHolding(userId);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Organization" title="Organization" subtitle="The holding and its companies." />
          <EmptyNote>You don&apos;t have access to the organization view.</EmptyNote>
        </>
      );
    }
    throw e;
  }

  const { root, companies, totals } = holding;

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title={root.name}
        subtitle={`Holding structure — ${totals.companies} ${totals.companies === 1 ? "company" : "companies"}, departments, divisions and people across the group.`}
      />

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 20 }}>
        <KpiTile label="Companies" value={String(totals.companies)} />
        <KpiTile label="Departments" value={String(totals.departments)} />
        <KpiTile label="Divisions" value={String(totals.divisions)} />
        <KpiTile label="People" value={String(totals.people)} foot={`${totals.roles} roles`} />
      </div>

      <Card title="Group structure" style={{ marginBottom: 20 }}>
        {companies.length === 0 ? (
          <EmptyNote>No companies are provisioned under this holding yet.</EmptyNote>
        ) : (
          <div className="org-preview erp-scroll" style={{ maxHeight: "none" }}>
            <ul className="org-chart">
              <li>
                <div className="org-box org-box--holding">
                  <span className="org-box__name">{root.name}</span>
                  <span className="org-box__meta">holding · {totals.companies} co.</span>
                </div>
                <ul>
                  {companies.map((c) => (
                    <li key={c.company.id}>
                      <div className="org-box org-box--company">
                        <span className="org-box__name">{c.company.name}</span>
                        <span className="org-box__meta">{c.company.type ?? "company"}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            </ul>
          </div>
        )}
      </Card>

      <Card title="Companies">
        {companies.length === 0 ? (
          <EmptyNote>Companies will appear here once they are provisioned on the platform.</EmptyNote>
        ) : (
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            {companies.map((c) => (
              <CompanyCard key={c.company.id} org={c} canEdit={elevated} />
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function CompanyCard({ org, canEdit }: { org: CompanyOrg; canEdit: boolean }) {
  const { company, counts, updatedAt } = org;
  const stat = (label: string, n: number) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ font: "700 18px var(--font-display)", color: "var(--text-primary)" }}>{n}</span>
      <span style={{ font: "700 9px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>{label}</span>
    </div>
  );
  return (
    <div style={{ border: "0.5px solid var(--erp-hairline)", background: "var(--surface-card)", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <Link href={`/companies/${company.id}`} style={{ font: "400 15px var(--font-body)", color: "var(--text-primary)", textDecoration: "none" }}>
          {company.name}
        </Link>
        <StatusBadge label={company.status} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {stat("Depts", counts.departments)}
        {stat("Divs", counts.divisions)}
        {stat("Roles", counts.roles)}
        {stat("People", counts.people)}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderTop: "0.5px solid var(--erp-hairline-soft)", paddingTop: 12 }}>
        <span style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)" }}>
          {updatedAt ? `Updated ${new Date(updatedAt).toLocaleDateString("en-GB")}` : "Not yet edited"}
        </span>
        <Link href={`/companies/${company.id}/org`} className="lux-btn lux-btn--ghost lux-btn--sm" style={{ textDecoration: "none" }}>
          {canEdit ? "Edit structure →" : "View structure →"}
        </Link>
      </div>
    </div>
  );
}
