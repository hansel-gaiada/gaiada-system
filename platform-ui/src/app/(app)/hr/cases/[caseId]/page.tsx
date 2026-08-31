import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { hrScopeCompanies, getCase } from "@/lib/hr";
import { cancelCase, toggleChecklistItem } from "@/lib/hrActions";
import { Card, Eyebrow, StatusBadge } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ChecklistToggle } from "@/components/hr/ChecklistToggle";
import { CancelLeaveButton } from "@/components/hr/CancelLeaveButton";
import { formatDateTime } from "@/lib/format";

type SearchParams = Promise<{ company?: string }>;

// HR › Case detail — checklist (onboarding/offboarding), review-lite fields
// (period/goals/outcome), or a plain note for grievance/other. WSD-5.
export default async function HrCaseDetailPage({ params, searchParams }: {
  params: Promise<{ caseId: string }>;
  searchParams: SearchParams;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const { caseId } = await params;
  const { company } = await searchParams;
  const scopeCompanies = hrScopeCompanies(me, tenant);
  // Only honor a `?company=` that's actually reachable (own tenant, or served) —
  // never probe an arbitrary tenant from a client-supplied param.
  const effectiveTenant = company && (company === tenant || scopeCompanies.some((c) => c.id === company)) ? company : tenant;

  const kase = await getCase(userId, effectiveTenant, caseId);
  if (!kase) {
    return (
      <>
        <Breadcrumbs items={[{ label: "HR", href: "/hr" }, { label: "Cases", href: "/hr/cases" }, { label: "Not found" }]} />
        <EmptyNote>This case doesn&apos;t exist, or you don&apos;t have access to it.</EmptyNote>
      </>
    );
  }

  const canManage = can(me, "hr.manage", effectiveTenant);
  const isOwn = kase.subjectUserId === userId;
  const isChecklist = kase.kind === "onboarding" || kase.kind === "offboarding";
  const items = kase.details?.items ?? [];
  const canCancel = kase.status !== "cancelled" && kase.status !== "done" && (canManage || isOwn);

  return (
    <>
      <Breadcrumbs items={[{ label: "HR", href: "/hr" }, { label: "Cases", href: "/hr/cases" }, { label: kase.title }]} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, margin: "14px 0 20px" }}>
        <div>
          <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 6, display: "block" }}>{kase.kind}</Eyebrow>
          <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 28, letterSpacing: "-0.015em", lineHeight: 1.065 }}>{kase.title}</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StatusBadge label={kase.status} />
          {canCancel && <CancelLeaveButton tenantId={effectiveTenant} id={kase.id} cancel={cancelCase} label="Cancel case" />}
        </div>
      </div>

      <Card title="Details" style={{ marginBottom: 20 }}>
        <DescriptionList
          items={[
            { label: "About", value: kase.subjectName ?? kase.subjectUserId ?? "—" },
            { label: "Opened", value: formatDateTime(kase.createdAt) },
            { label: "Last updated", value: formatDateTime(kase.updatedAt) },
          ]}
        />
      </Card>

      {isChecklist ? (
        <Card title="Checklist">
          {items.length === 0 ? (
            <EmptyNote>No checklist items on this case.</EmptyNote>
          ) : (
            <ChecklistToggle
              tenantId={effectiveTenant}
              caseId={kase.id}
              items={items}
              update={toggleChecklistItem}
              readOnly={!canManage && !isOwn}
            />
          )}
        </Card>
      ) : kase.kind === "review" ? (
        <Card title="Review">
          <DescriptionList
            items={[
              { label: "Period", value: kase.details?.period ?? "—" },
              { label: "Goals", value: kase.details?.goals ?? "—" },
              { label: "Outcome", value: kase.details?.outcome ?? "—" },
            ]}
          />
        </Card>
      ) : (
        <Card title="Notes">
          <EmptyNote>Nothing else recorded on this case yet.</EmptyNote>
        </Card>
      )}

      <div style={{ marginTop: 16 }}>
        <Link href="/hr/cases" className="lux-btn lux-btn--ghost lux-btn--sm">← Back to cases</Link>
      </div>
    </>
  );
}
