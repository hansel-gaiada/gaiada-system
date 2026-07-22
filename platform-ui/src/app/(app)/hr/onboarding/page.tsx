import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listMembers } from "@/lib/entities";
import {
  hrScopeCompanies, resolveHrScopeParam, fanOutHr, rawListCases, listChecklistTemplates,
  checklistProgress, HR_CASE_STATUSES, type HrCase, type HrCaseStatus,
} from "@/lib/hr";
import { instantiateOnboarding, createChecklistTemplate } from "@/lib/hrActions";
import { Card, Eyebrow, humanizeStatus } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { HrCompanyScope, HrEnvelopeBanner } from "@/components/hr/HrCompanyScope";
import { InstantiateForm } from "@/components/hr/InstantiateForm";
import { TemplateForm } from "@/components/hr/TemplateForm";

type SearchParams = Promise<{ company?: string }>;
type Row = HrCase & { tenantId: string; tenantName: string };

const COLUMN_LABEL: Record<HrCaseStatus, string> = {
  open: "Open", in_progress: "In progress", done: "Done", cancelled: "Cancelled",
};

function OnboardingCard({ c, showCompany }: { c: Row; showCompany: boolean }) {
  const { done, total } = checklistProgress(c);
  return (
    <Link href={`/hr/cases/${c.id}?company=${c.tenantId}`} style={{ textDecoration: "none", color: "inherit" }}>
      <div style={{ border: "0.5px solid var(--erp-hairline)", padding: 12, marginBottom: 10, background: "var(--erp-surface, transparent)" }}>
        <div style={{ font: "700 10px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: c.kind === "onboarding" ? "var(--erp-accent)" : "var(--erp-ink-50)" }}>
          {c.kind}
        </div>
        <div style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)", margin: "4px 0" }}>{c.title}</div>
        <div style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
          {c.subjectName ?? c.subjectUserId ?? "—"}{showCompany ? ` · ${c.tenantName}` : ""}
        </div>
        {total > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ height: 4, background: "var(--erp-hairline)", position: "relative" }}>
              <div style={{ height: 4, width: `${Math.round((done / total) * 100)}%`, background: "var(--erp-accent)" }} />
            </div>
            <div style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)", marginTop: 4 }}>{done} / {total} steps</div>
          </div>
        )}
      </div>
    </Link>
  );
}

// HR › Onboarding — checklist board for onboarding/offboarding cases, fanned
// out across every HR company the viewer serves (hr.view), plus template
// management and manual instantiation (hr.manage). WSD-5.
export default async function HrOnboardingPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <Card><EmptyNote>Select a company from the top bar.</EmptyNote></Card>;

  const { company } = await searchParams;
  const scopeCompanies = hrScopeCompanies(me, tenant);
  const scope = resolveHrScopeParam(company, scopeCompanies);
  const canManageAny = scopeCompanies.some((c) => can(me, "hr.manage", c.id));

  if (scopeCompanies.length === 0) {
    return (
      <Card>
        <EmptyNote>Onboarding/offboarding checklists are visible to HR staff and managers. Your own checklist (if any) is on your employee page.</EmptyNote>
      </Card>
    );
  }

  const targets = scope === "all" ? scopeCompanies : scopeCompanies.filter((c) => c.id === scope);
  const [envelope, templates, members] = await Promise.all([
    fanOutHr(targets, (companyId) => rawListCases(userId, companyId, {})),
    listChecklistTemplates(userId, tenant),
    canManageAny ? listMembers(userId, tenant).catch(() => []) : Promise.resolve([]),
  ]);
  const cases = envelope.items.filter((c) => c.kind === "onboarding" || c.kind === "offboarding") as (HrCase & { tenantId: string; tenantName: string })[];

  const byStatus = new Map<HrCaseStatus, Row[]>();
  for (const s of HR_CASE_STATUSES) byStatus.set(s, []);
  for (const c of cases) byStatus.get(c.status)?.push(c);

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
        <div>
          <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 6, display: "block" }}>Onboarding</Eyebrow>
          <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--erp-ink-60)", maxWidth: 560 }}>
            Onboarding/offboarding checklists, spawned automatically on invite or started manually below.
          </p>
        </div>
        <HrCompanyScope companies={scopeCompanies} value={scope} />
      </div>

      <HrEnvelopeBanner companies={envelope.companies} />

      {canManageAny && members.length > 0 && (
        <Card title="Start a checklist" style={{ marginBottom: 20 }}>
          <InstantiateForm instantiate={instantiateOnboarding} tenantId={scope === "all" ? tenant : scope} subjectOptions={members.map((m) => ({ value: m.user_id, label: m.name }))} />
        </Card>
      )}

      {cases.length === 0 ? (
        <Card><EmptyNote>No onboarding or offboarding checklists yet.</EmptyNote></Card>
      ) : (
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginBottom: 24 }}>
          {HR_CASE_STATUSES.map((s) => (
            <div key={s}>
              <div style={{ font: "700 11px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-50)", marginBottom: 10 }}>
                {COLUMN_LABEL[s]} · {byStatus.get(s)?.length ?? 0}
              </div>
              {(byStatus.get(s) ?? []).map((c) => <OnboardingCard key={c.id} c={c} showCompany={scope === "all"} />)}
            </div>
          ))}
        </div>
      )}

      <Card title="Checklist templates" headerRight={canManageAny ? <TemplateForm create={createChecklistTemplate} companyId={tenant} /> : undefined}>
        {templates.length === 0 ? (
          <EmptyNote>No templates configured for {me.companies.find((c) => c.id === tenant)?.name ?? "this company"} yet.</EmptyNote>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {templates.map((t) => (
              <li key={t.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderTop: "0.5px solid var(--erp-hairline)" }}>
                <span style={{ font: "400 14px var(--font-body)" }}>{t.name} {t.isDefault && <em style={{ color: "var(--erp-accent)", fontStyle: "normal" }}>· default</em>}</span>
                <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>{humanizeStatus(t.kind)} · {t.items.length} steps</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
