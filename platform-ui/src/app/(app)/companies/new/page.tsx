import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import { listCompanies } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { CompanyForm } from "@/components/forms/CompanyForm";
import { createCompanyAction } from "../actions";

export default async function NewCompanyPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);

  if (!isElevated(me)) {
    return (
      <>
        <PageHeader eyebrow="Organization" title="New company" breadcrumbs={[{ label: "Companies", href: "/companies" }, { label: "New" }]} />
        <EmptyNote>Only owners and administrators can create companies.</EmptyNote>
      </>
    );
  }

  const companies = (await listCompanies(userId).catch(() => [])).map((c) => ({ id: c.id, name: c.name }));

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="New company"
        subtitle="Add a company under the holding."
        breadcrumbs={[{ label: "Companies", href: "/companies" }, { label: "New" }]}
      />
      <Card>
        <CompanyForm action={createCompanyAction} companies={companies} />
      </Card>
    </>
  );
}
