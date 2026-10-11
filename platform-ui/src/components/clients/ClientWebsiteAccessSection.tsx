import { getStaffWebsiteAccess } from "@/lib/clientWebsiteAccess";
import { canManageClientAdmin, canManageWebsiteEditor } from "@/lib/clientWebsiteAccessView";
import type { Me } from "@/lib/platform";
import { Card } from "@/components/ui";
import { ClientWebsiteAccessPanel } from "@/components/clients/ClientWebsiteAccessPanel";

// WSK-49f — the staff "Website access" card, as ONE server component so the Contacts page needs a single
// import and a single render line (the page is being edited in parallel by another ticket). It does the
// read here: a typed result (ok / forbidden / unavailable), never collapsed to [], so a refused or failed
// read can not render as "nobody has access".
export async function ClientWebsiteAccessSection({
  me,
  userId,
  tenant,
  clientId,
  clientName,
}: {
  me: Me;
  userId: string;
  tenant: string;
  clientId: string;
  clientName: string;
}) {
  const initial = await getStaffWebsiteAccess(userId, tenant, clientId);
  return (
    <div style={{ marginTop: 20 }}>
      <Card title="Website access">
        <ClientWebsiteAccessPanel
          clientId={clientId}
          clientName={clientName}
          initial={initial}
          canManageEditor={canManageWebsiteEditor(me, tenant)}
          canManageAdmin={canManageClientAdmin(me, tenant)}
        />
      </Card>
    </div>
  );
}
