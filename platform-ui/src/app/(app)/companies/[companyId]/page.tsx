import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isElevated, can } from "@/lib/rbac";
import { getCompany, listCompanies, type Company } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card } from "@/components/ui";

// `getCompany` derives from the full /api/companies list and looks the
// company up by id, ignoring the tenant argument — the tenantId is still
// resolved here to keep the call shape consistent with the rest of the app.
type CompanyWithParent = Company & { parent_company_id?: string | null };

export default async function CompanyDetailPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenantId = await getActiveTenant(me);
  let company: CompanyWithParent | null;
  try {
    company = (await getCompany(userId, tenantId ?? "", companyId)) as CompanyWithParent | null;
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Company" title="Company" />
          <Card>
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
              You don&apos;t have access to this in the current company.
            </p>
          </Card>
        </>
      );
    }
    throw e;
  }
  if (!company) notFound();

  const canManage = can(me, "company.manage", companyId) || isElevated(me);
  const parentName = company.parent_company_id
    ? (await listCompanies(userId).catch(() => [])).find((c) => c.id === company!.parent_company_id)?.name ?? company.parent_company_id
    : null;

  const items: { label: string; value: ReactNode }[] = [
    { label: "Type", value: company.type ?? "—" },
    { label: "Status", value: company.status },
    { label: "Enabled modules", value: (company.enabled_modules ?? []).join(", ") || "None" },
  ];
  if (parentName) {
    items.splice(1, 0, {
      label: "Parent",
      value: <Link href={`/companies/${company.parent_company_id}`}>{parentName}</Link>,
    });
  }

  return (
    <>
      <PageHeader
        eyebrow="Company"
        title={company.name}
        breadcrumbs={[{ label: "Companies", href: "/companies" }, { label: company.name }]}
        actions={
          <>
            <Link href={`/companies/${company.id}/org`} className="lux-btn lux-btn--ghost lux-btn--sm">Org structure</Link>
            {canManage && <Link href={`/companies/${company.id}/edit`} className="lux-btn lux-btn--solid lux-btn--sm">Edit</Link>}
          </>
        }
      />
      <DescriptionList items={items} />
    </>
  );
}
