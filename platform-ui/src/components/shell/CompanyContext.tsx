import type { Me } from "@/lib/platform";
import { accessibleCompanies, canSwitchCompany } from "@/lib/rbac";
import { Eyebrow } from "@/components/ui";
import { TenantSwitcher } from "./TenantSwitcher";

// The top-level company context. Everything in the app is scoped to the active
// company, so this is shown prominently. Users who can reach more than one
// company (elevated / multi-company grants) get a switcher; everyone else sees
// a static label of the single company they're in.
export function CompanyContext({ me, tenantId }: { me: Me; tenantId: string | null }) {
  const companies = accessibleCompanies(me);
  if (companies.length === 0) return null;
  const current = companies.find((c) => c.id === tenantId) ?? companies[0];

  return (
    <div className="erp-company">
      <Eyebrow style={{ fontSize: 9, opacity: 0.5 }}>Company</Eyebrow>
      {canSwitchCompany(me) ? (
        <TenantSwitcher companies={companies} current={current.id} />
      ) : (
        <span className="erp-company__name">{current.name}</span>
      )}
    </div>
  );
}
