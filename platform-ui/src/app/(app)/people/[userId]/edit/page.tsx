import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getEmployee } from "@/lib/people";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { EmployeeForm } from "@/components/forms/EmployeeForm";
import { updateEmployeeAction } from "../../actions";

type Params = Promise<{ userId: string }>;

export default async function EditEmployeePage({ params }: { params: Params }) {
  const viewerId = await getSessionUserId();
  if (!viewerId) redirect("/login");
  const me = await getMe(viewerId);
  const tenant = await getActiveTenant(me);
  const { userId } = await params;
  const crumbs = [{ label: "People", href: "/people" }, { label: "Edit" }];

  if (!tenant || !can(me, "admin.access", tenant)) {
    return (<><PageHeader eyebrow="People" title="Edit employee" breadcrumbs={crumbs} /><EmptyNote>You don&apos;t have permission to edit people in this company.</EmptyNote></>);
  }

  const emp = await getEmployee(viewerId, tenant, userId, me);
  if (!emp) notFound();
  const { profile } = emp;
  const action = updateEmployeeAction.bind(null, userId);

  return (
    <>
      <PageHeader
        eyebrow="People"
        title={`Edit ${profile.name}`}
        subtitle={<>Profile &amp; status. Manage roles from <Link href="/admin/users">Users &amp; Roles</Link>.</>}
        breadcrumbs={[{ label: "People", href: "/people" }, { label: profile.name, href: `/people/${userId}` }, { label: "Edit" }]}
      />
      <Card>
        <EmployeeForm action={action} mode="edit" employee={{ name: profile.name, email: profile.email, title: profile.title, status: profile.status }} />
      </Card>
    </>
  );
}
