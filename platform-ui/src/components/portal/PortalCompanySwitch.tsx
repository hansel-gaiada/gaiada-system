import { switchPortalCompany } from "@/lib/portal-company";

// PV2-05 — shown in the portal header ONLY for a contact of more than one company (the caller
// decides; with one company there is nothing to switch). It posts to a server action that validates
// the id against the caller's `clientOf`. Plain form, no client JS: the select submits on the button.
export function PortalCompanySwitch({
  companies, activeId,
}: {
  companies: { companyId: string; companyName: string }[];
  activeId: string | null;
}) {
  return (
    <form action={switchPortalCompany} className="cp-switch">
      <label htmlFor="cp-company-switch" className="cp-switch__label">Company</label>
      <select
        id="cp-company-switch"
        name="tenantId"
        className="cp-select cp-switch__select"
        defaultValue={activeId ?? undefined}
      >
        {companies.map((c) => (
          <option key={c.companyId} value={c.companyId}>{c.companyName}</option>
        ))}
      </select>
      <button type="submit" className="cp-switch__go">Switch</button>
    </form>
  );
}
