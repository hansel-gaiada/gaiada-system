import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { isElevated, can } from "@/lib/rbac";
import { getCompany, listCompanies } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { CompanyForm } from "@/components/forms/CompanyForm";
import { updateCompanyAction } from "../../actions";

type Params = Promise<{ companyId: string }>;

export default async function EditCompanyPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const { companyId } = await params;

  const company = await getCompany(userId, companyId, companyId);
  if (!company) notFound();

  if (!can(me, "company.manage", companyId) && !isElevated(me)) {
    return (
      <>
        <PageHeader eyebrow="Organization" title={`Edit ${company.name}`} breadcrumbs={[{ label: "Companies", href: "/companies" }, { label: company.name, href: `/companies/${companyId}` }, { label: "Edit" }]} />
        <EmptyNote>You don&apos;t have permission to edit this company.</EmptyNote>
      </>
    );
  }

  const companies = (await listCompanies(userId).catch(() => [])).map((c) => ({ id: c.id, name: c.name }));
  const action = updateCompanyAction.bind(null, companyId);

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title={`Edit ${company.name}`}
        breadcrumbs={[{ label: "Companies", href: "/companies" }, { label: company.name, href: `/companies/${companyId}` }, { label: "Edit" }]}
      />
      <Card>
        <CompanyForm action={action} companies={companies} company={company} />
      </Card>
    </>
  );
}
