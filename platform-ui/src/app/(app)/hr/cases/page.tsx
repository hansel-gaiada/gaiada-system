import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listMembers } from "@/lib/entities";
import { hrScopeCompanies, resolveHrScopeParam, fanOutHr, listCases, rawListCases, HR_CASE_KINDS, type HrCaseKind, type HrEnvelopeCompany } from "@/lib/hr";
import { createCase } from "@/lib/hrActions";
import { Card, Eyebrow, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { HrCompanyScope, HrEnvelopeBanner } from "@/components/hr/HrCompanyScope";
import { CaseForm } from "@/components/hr/CaseForm";
import { formatDate } from "@/lib/format";

type SearchParams = Promise<{ company?: string; kind?: string }>;

// HR › Cases — self-service listing for everyone (own cases only), widening to
// every case in scope for hr_staff/hr_manager/company_admin/elevated, fanned
// out across every served HR company. WSD-5.
export default async function HrCasesPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const { company, kind } = await searchParams;
  const scopeCompanies = hrScopeCompanies(me, tenant);
  const scope = resolveHrScopeParam(company, scopeCompanies);
  const kindFilter = HR_CASE_KINDS.includes(kind as HrCaseKind) ? (kind as HrCaseKind) : undefined;
  const canFileForOthers = scopeCompanies.some((c) => can(me, "hr.manage", c.id));

  let rows: { id: string; kind: string; title: string; subjectName?: string | null; subjectUserId: string | null; status: string; company?: string; companyId?: string; createdAt: string }[];
  let envelopeCompanies: HrEnvelopeCompany[] = [];

  if (scopeCompanies.length === 0) {
    const mine = await listCases(userId, tenant, { subjectUserId: userId, kind: kindFilter });
    rows = mine.map((c) => ({ id: c.id, kind: c.kind, title: c.title, subjectName: c.subjectName, subjectUserId: c.subjectUserId, status: c.status, companyId: tenant, createdAt: c.createdAt }));
  } else {
    const targets = scope === "all" ? scopeCompanies : scopeCompanies.filter((c) => c.id === scope);
    const envelope = await fanOutHr(targets, (companyId) => rawListCases(userId, companyId, { kind: kindFilter }));
    envelopeCompanies = envelope.companies;
    rows = envelope.items.map((c) => ({ id: c.id, kind: c.kind, title: c.title, subjectName: c.subjectName, subjectUserId: c.subjectUserId, status: c.status, company: scope === "all" ? c.tenantName : undefined, companyId: c.tenantId, createdAt: c.createdAt }));
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const subjectOptions = canFileForOthers
    ? (await listMembers(userId, tenant).catch(() => [])).map((m) => ({ value: m.user_id, label: m.name }))
    : undefined;

  const kindChip = (label: string, value: string | undefined) => {
    const qsp = new URLSearchParams({ ...(company ? { company } : {}), ...(value ? { kind: value } : {}) });
    const str = qsp.toString();
    return (
      <Link key={label} href={`/hr/cases${str ? `?${str}` : ""}`} className="lux-btn lux-btn--ghost lux-btn--sm"
        style={{ textDecoration: "none", ...(kindFilter === value ? { borderColor: "var(--erp-accent)", color: "var(--erp-accent)" } : {}) }}>
        {label}
      </Link>
    );
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
        <div>
          <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 6, display: "block" }}>Cases</Eyebrow>
          <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--erp-ink-60)", maxWidth: 560 }}>
            Onboarding, offboarding, review-lite, grievance and general HR cases.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {scopeCompanies.length > 0 && <HrCompanyScope companies={scopeCompanies} value={scope} />}
          <CaseForm create={createCase} companyId={tenant} subjectOptions={subjectOptions} defaultKind="other" />
        </div>
      </div>

      {envelopeCompanies.length > 0 && <HrEnvelopeBanner companies={envelopeCompanies} />}

      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {kindChip("All", undefined)}
          {HR_CASE_KINDS.map((k) => kindChip(k, k))}
        </div>
      </Card>

      <Card>
        {rows.length === 0 ? (
          <EmptyNote>{kindFilter ? `No ${kindFilter} cases yet.` : "No cases yet."}</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Kind" }, { label: "Title" }, { label: "About" }, { label: "Status" }, ...(scope === "all" ? [{ label: "Company" }] : []), { label: "Opened", align: "right" }]}
            rows={rows.map((r) => [
              <Link key="k" href={`/hr/cases/${r.id}?company=${r.companyId ?? tenant}`} style={{ color: "var(--text-primary)", textDecoration: "none" }}>{r.kind}</Link>,
              r.title,
              r.subjectName ?? r.subjectUserId ?? "—",
              <StatusBadge key="s" label={r.status} />,
              ...(scope === "all" ? [r.company ?? "—"] : []),
              formatDate(r.createdAt),
            ])}
            tcols={scope === "all" ? "0.8fr 1.6fr 1.2fr 0.9fr 1fr 1fr" : "0.8fr 1.8fr 1.3fr 0.9fr 1fr"}
          />
        )}
      </Card>
    </>
  );
}
