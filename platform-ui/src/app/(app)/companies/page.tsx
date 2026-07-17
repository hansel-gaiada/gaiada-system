import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import { listCompanies, type Company } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DataTable, type Column } from "@/components/data/DataTable";

// D & A Syrowatka is a holding: the /organization page shows the hierarchy;
// this is the flat, searchable/sortable register of all companies.
const COLUMNS: Column[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "type", header: "Type", sortable: true },
  { key: "modules", header: "Modules" },
  { key: "status", header: "Status", format: "status", sortable: true, align: "right" },
];

export default async function CompaniesPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);

  let companies: Company[];
  try {
    companies = await listCompanies(userId);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Organization" title="Companies" subtitle="D & A Syrowatka and its companies." />
          <EmptyNote>You don&apos;t have access to this in the current company.</EmptyNote>
        </>
      );
    }
    throw e;
  }

  const rows = companies
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ id: c.id, name: c.name, type: c.type ?? "—", modules: (c.enabled_modules ?? []).join(", ") || "—", status: c.status }));

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Companies"
        subtitle="D & A Syrowatka and its companies."
        actions={isElevated(me) ? <Link href="/companies/new" className="lux-btn lux-btn--solid lux-btn--sm">New company</Link> : undefined}
      />
      {companies.length === 0 ? (
        <Card><EmptyNote>No companies yet. Companies will appear here once they are provisioned.</EmptyNote></Card>
      ) : (
        <DataTable columns={COLUMNS} rows={rows} link={{ base: "/companies", idKey: "id", labelKey: "name" }} csvName="companies" pageSize={20} />
      )}
    </>
  );
}
