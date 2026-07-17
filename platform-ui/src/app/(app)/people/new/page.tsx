import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listRoles } from "@/lib/adminData";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { EmployeeForm } from "@/components/forms/EmployeeForm";
import { inviteEmployeeAction } from "../actions";

export default async function InviteEmployeePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  const crumbs = [{ label: "People", href: "/people" }, { label: "Invite" }];
  if (!tenant || !can(me, "admin.access", tenant)) {
    return (
      <>
        <PageHeader eyebrow="People" title="Invite employee" breadcrumbs={crumbs} />
        <EmptyNote>You don&apos;t have permission to invite people in this company.</EmptyNote>
      </>
    );
  }

  const roles = (await listRoles(userId).catch(() => [])).map((r) => ({ id: r.id, name: r.name }));

  return (
    <>
      <PageHeader
        eyebrow="People"
        title="Invite employee"
        subtitle="Onboard a person into this company. They receive an invite and appear in the directory."
        breadcrumbs={crumbs}
      />
      <Card>
        <EmployeeForm action={inviteEmployeeAction} mode="invite" roles={roles} />
      </Card>
    </>
  );
}
