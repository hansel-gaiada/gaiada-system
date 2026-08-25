import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getClientOverview } from "@/lib/clientHub";
import { deleteClientForm } from "@/lib/clientWorkActions";
import { PageHeader } from "@/components/PageHeader";
import { ClientHubTabs, type ClientHubTab } from "@/components/clients/ClientHubTabs";
import "@/components/clients/clientHub.css";

// CC-3 — the client hub shell.
//
// ── WHY THE HUB EXISTS ───────────────────────────────────────────────────────────────────────────
// The ERP is organised object-first (`/projects`, `/tasks`, `/billing`, `/approvals`), and before this
// the one page named after a client showed their contacts and calendar and none of their work. The
// client portal, meanwhile, has always shown a client everything they own on one surface — so staff
// had a WORSE client-centric view than the client did. This shell is the staff mirror of it.
//
// ── ONE FETCH, IN THE LAYOUT ─────────────────────────────────────────────────────────────────────
// The aggregate is fetched HERE rather than per tab so the tab badges are present on every tab, and
// Next dedupes the identical fetch within one render pass — so the Overview tab, which needs the same
// payload, costs nothing extra. Any tab that needs a count already has it.
//
// ── WHY A LAYOUT THROW IS ACCEPTABLE HERE (AND IS NOT IN THE PORTAL) ─────────────────────────────
// `(portal)/portal/layout.tsx` deliberately `.catch(() => null)`s its overview: an external client
// must still get chrome and a "something is wrong" message rather than a blank page. This layout does
// the OPPOSITE and lets a failure throw to the error boundary, because the reader is staff and the
// failure mode that matters is different — a hub that renders zeroes tells a manager their client has
// no work, nothing outstanding and no money owed. Wrong-and-confident beats nothing here only if you
// never act on it, and this is the screen people act on. A 404 (no such client in this tenant) is
// still a real 404.
export default async function ClientHubLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clientId: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { clientId } = await params;
  if (!tenant) notFound();

  const overview = await getClientOverview(userId, tenant, clientId);
  if (!overview) notFound();

  // The Overview badge is `needsUs`, NOT `needsUs + needsClient`. The hub's job is to surface what
  // this company has to do; a badge that also counts what we are waiting on THEM for would never
  // reach zero for a healthy client and would therefore stop meaning anything.
  const tabs: ClientHubTab[] = [
    { segment: "", label: "Overview", badge: overview.needsUs.length },
    { segment: "work", label: "Work", badge: overview.tasks.overdue },
    { segment: "details", label: "Details" },
  ];

  const canManage = can(me, "pm.manage", tenant);
  const del = deleteClientForm.bind(null, clientId);

  return (
    <>
      <PageHeader
        title={overview.client.name}
        breadcrumbs={[{ label: "Clients", href: "/clients" }, { label: overview.client.name }]}
        actions={
          canManage ? (
            <form action={del}>
              <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Delete</button>
            </form>
          ) : undefined
        }
      />
      <ClientHubTabs clientId={clientId} tabs={tabs} />
      {children}
    </>
  );
}
